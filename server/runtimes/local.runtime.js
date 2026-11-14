const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { db } = require("../../database/db");
const botConfigService = require("../services/bot-config.service");

const BOTS_DIR = path.resolve(__dirname, "../../storage/bots");
const LOGS_DIR = path.resolve(__dirname, "../../storage/logs");

const BOT_MAX_OLD_SPACE_MB = Number(
    process.env.BOT_MAX_OLD_SPACE_MB || 256
);

if (
    !Number.isSafeInteger(BOT_MAX_OLD_SPACE_MB) ||
    BOT_MAX_OLD_SPACE_MB < 64 ||
    BOT_MAX_OLD_SPACE_MB > 2048
) {
    throw new Error("BOT_MAX_OLD_SPACE_MB must be between 64 and 2048.");
}

const MAX_LOG_BYTES = 1024 * 1024;

const BOT_MAX_RSS_MB = Number(process.env.BOT_MAX_RSS_MB || 512);
const RESOURCE_CHECK_INTERVAL_MS = 5000;
const RESOURCE_LIMIT_CONSECUTIVE_CHECKS = 2;

if (
    !Number.isSafeInteger(BOT_MAX_RSS_MB) ||
    BOT_MAX_RSS_MB < 64 ||
    BOT_MAX_RSS_MB > 16384
) {
    throw new Error("BOT_MAX_RSS_MB must be between 64 and 16384.");
}

const processes = new Map();

fs.mkdirSync(LOGS_DIR, { recursive: true });

function updateStatus(botId, status) {
    db.prepare(`
        UPDATE bots
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(status, botId);
}

function updateLatestDeployment(botId, status, options = {}) {
    const deployment = db.prepare(`
        SELECT id FROM deployments
        WHERE bot_id = ?
        ORDER BY version DESC
        LIMIT 1
    `).get(botId);

    if (!deployment) return;

    const started = options.started ? 1 : 0;
    const finished = options.finished ? 1 : 0;

    db.prepare(`
        UPDATE deployments
        SET status = ?,
            started_at = CASE
                WHEN ? = 1 THEN CURRENT_TIMESTAMP
                ELSE started_at
            END,
            finished_at = CASE
                WHEN ? = 1 THEN CURRENT_TIMESTAMP
                WHEN ? = 1 THEN NULL
                ELSE finished_at
            END,
            error_message = ?
        WHERE id = ?
    `).run(
        status,
        started,
        finished,
        started,
        options.error || null,
        deployment.id
    );
}

function getOwnedBot(botId, ownerId) {
    return db.prepare(`
        SELECT id, owner_id, name, runtime, entry_file, status
        FROM bots
        WHERE id = ? AND owner_id = ?
    `).get(botId, ownerId);
}

function prepareLogFile(logPath) {
    if (fs.existsSync(logPath)) {
        const size = fs.statSync(logPath).size;

        if (size >= MAX_LOG_BYTES) {
            const backupPath = `${logPath}.1`;

            if (fs.existsSync(backupPath)) {
                fs.unlinkSync(backupPath);
            }

            fs.renameSync(logPath, backupPath);
        }
    }

    return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
}

function writeBoundedLog(record, data) {
    if (record.logLimitReached) return;

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const remaining = MAX_LOG_BYTES - record.logBytes;

    if (remaining <= 0) {
        record.logLimitReached = true;
        record.logStream.write(
            "\n[LOG LIMIT REACHED] Further output discarded.\n"
        );
        return;
    }

    const allowed = buffer.subarray(0, remaining);

    if (allowed.length) {
        record.logStream.write(allowed);
        record.logBytes += allowed.length;
    }

    if (allowed.length < buffer.length) {
        record.logLimitReached = true;
        record.logStream.write(
            "\n[LOG LIMIT REACHED] Further output discarded.\n"
        );
    }
}

async function startBot(botId, ownerId) {
    const bot = getOwnedBot(botId, ownerId);

    if (!bot) throw new Error("Bot not found.");
    if (processes.has(botId)) {
        throw new Error("Bot is already running.");
    }

    const botDir = path.resolve(BOTS_DIR, botId);
    const entryFile = path.resolve(botDir, bot.entry_file);

    if (!entryFile.startsWith(botDir + path.sep)) {
        throw new Error("Invalid bot entry file.");
    }

    if (!fs.existsSync(entryFile) || !fs.statSync(entryFile).isFile()) {
        throw new Error("Bot entry file not found. Upload your source files first.");
    }

    const realBotDir = fs.realpathSync(botDir);
    const realEntryFile = fs.realpathSync(entryFile);
    const relativeEntry = path.relative(realBotDir, realEntryFile);

    if (
        !relativeEntry ||
        relativeEntry.startsWith(".." + path.sep) ||
        relativeEntry === ".." ||
        path.isAbsolute(relativeEntry)
    ) {
        throw new Error("Bot entry file cannot escape its assigned directory.");
    }

    const botDataDir = path.join(botDir, ".nexhost");
    const botHome = path.join(botDataDir, "home");
    const botTmp = path.join(botDataDir, "tmp");

    for (const dir of [botDataDir, botHome, botTmp]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
    }

    const logPath = path.join(LOGS_DIR, `${botId}.log`);
    const logBytes = prepareLogFile(logPath);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    const record = {
        child: null,
        logStream,
        logBytes,
        logLimitReached: false,
        stopping: false,
        finalized: false,
        resourceMonitor: null,
        resourceKillTimeout: null,
        resourceLimitExceeded: false,
        consecutiveMemoryLimitChecks: 0,
        startedAt: new Date().toISOString()
    };

    updateLatestDeployment(botId, "starting", { started: true });

    let child;

    const runtimeConfig = botConfigService.getRuntimeConfig(botId);

    try {
        child = spawn(
            process.execPath,
            [
                `--max-old-space-size=${BOT_MAX_OLD_SPACE_MB}`,
                realEntryFile,
                ...runtimeConfig.startupArgs
            ],
            {
                cwd: botDir,
                shell: false,
                detached: false,
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                    PATH: process.env.PATH || "",
                    HOME: botHome,
                    TMPDIR: botTmp,
                    NODE_ENV: "production",
                    ...runtimeConfig.environment
                }
            }
        );
    } catch (error) {
        updateStatus(botId, "crashed");
        updateLatestDeployment(botId, "failed", {
            finished: true,
            error: error.message
        });
        logStream.end();
        throw new Error(`Unable to start bot: ${error.message}`);
    }

    record.child = child;
    processes.set(botId, record);

    child.stdout.on("data", data => writeBoundedLog(record, data));
    child.stderr.on("data", data => writeBoundedLog(record, data));

    function finalize(status, deploymentStatus, errorMessage = null) {
        if (record.finalized) return;
        record.finalized = true;

        if (record.resourceMonitor) {
            clearInterval(record.resourceMonitor);
            record.resourceMonitor = null;
        }

        if (record.resourceKillTimeout) {
            clearTimeout(record.resourceKillTimeout);
            record.resourceKillTimeout = null;
        }

        if (processes.get(botId) === record) {
            processes.delete(botId);
            cpuSamples.delete(botId);
        }

        updateStatus(botId, status);
        updateLatestDeployment(botId, deploymentStatus, {
            finished: true,
            error: errorMessage
        });

        if (errorMessage) {
            writeBoundedLog(record, `\n[PROCESS ERROR] ${errorMessage}\n`);
        }

        logStream.end();
    }

    child.on("error", error => {
        finalize("crashed", "failed", error.message);
    });

    child.on("exit", (code, signal) => {
        const stopped =
            !record.resourceLimitExceeded &&
            (record.stopping || code === 0);

        const status = stopped ? "stopped" : "crashed";
        const deploymentStatus = stopped ? "stopped" : "failed";

        const error = record.resourceLimitExceeded
            ? `Bot exceeded its ${BOT_MAX_RSS_MB} MB RSS memory limit.`
            : stopped
                ? null
                : `Process exited unexpectedly. code=${code}, signal=${signal}`;

        writeBoundedLog(
            record,
            `\n[PROCESS EXIT] code=${code} signal=${signal} status=${status}\n`
        );

        finalize(status, deploymentStatus, error);
    });

    return new Promise((resolve, reject) => {
        child.once("spawn", () => {
            updateStatus(botId, "running");
            updateLatestDeployment(botId, "running");

            record.resourceMonitor = setInterval(() => {
                if (
                    record.finalized ||
                    record.stopping ||
                    record.resourceLimitExceeded
                ) {
                    return;
                }

                try {
                    const statusText = fs.readFileSync(
                        `/proc/${child.pid}/status`,
                        "utf8"
                    );

                    const match = statusText.match(/^VmRSS:\s+(\d+)\s+kB/m);

                    if (!match) return;

                    const memoryMB = Number(match[1]) / 1024;

                    if (memoryMB > BOT_MAX_RSS_MB) {
                        record.consecutiveMemoryLimitChecks++;
                    } else {
                        record.consecutiveMemoryLimitChecks = 0;
                    }

                    if (
                        record.consecutiveMemoryLimitChecks <
                        RESOURCE_LIMIT_CONSECUTIVE_CHECKS
                    ) {
                        return;
                    }

                    record.resourceLimitExceeded = true;

                    writeBoundedLog(
                        record,
                        `\n[RESOURCE GUARD] RSS memory ${memoryMB.toFixed(2)} MB exceeded the ${BOT_MAX_RSS_MB} MB limit. Sending SIGTERM.\n`
                    );

                    child.kill("SIGTERM");

                    record.resourceKillTimeout = setTimeout(() => {
                        if (!record.finalized && child.exitCode === null) {
                            writeBoundedLog(
                                record,
                                "\n[RESOURCE GUARD] Grace period expired. Sending SIGKILL.\n"
                            );

                            child.kill("SIGKILL");
                        }
                    }, 5000);

                } catch (error) {
                    if (error.code !== "ENOENT") {
                        writeBoundedLog(
                            record,
                            `\n[RESOURCE GUARD] Memory check failed: ${error.message}\n`
                        );
                    }
                }
            }, RESOURCE_CHECK_INTERVAL_MS);

            record.resourceMonitor.unref();

            resolve({
                botId,
                pid: child.pid,
                status: "running"
            });
        });

        child.once("error", error => {
            reject(new Error(`Unable to start bot: ${error.message}`));
        });
    });
}

async function stopBot(botId, ownerId) {
    const bot = getOwnedBot(botId, ownerId);

    if (!bot) throw new Error("Bot not found.");

    const record = processes.get(botId);

    if (!record) {
        updateStatus(botId, "stopped");
        updateLatestDeployment(botId, "stopped", { finished: true });

        return { botId, status: "stopped" };
    }

    record.stopping = true;
    record.child.kill("SIGTERM");

    await new Promise(resolve => {
        const timeout = setTimeout(() => {
            if (processes.get(botId) === record) {
                record.child.kill("SIGKILL");
            }
        }, 5000);

        record.child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });
    });

    return { botId, status: "stopped" };
}

function getBotStatus(botId, ownerId) {
    const bot = getOwnedBot(botId, ownerId);

    if (!bot) throw new Error("Bot not found.");

    const record = processes.get(botId);

    return {
        botId,
        name: bot.name,
        status: record ? "running" : bot.status,
        pid: record ? record.child.pid : null,
        startedAt: record ? record.startedAt : null
    };
}

function getBotLogs(botId, ownerId, lines = 50) {
    const bot = getOwnedBot(botId, ownerId);

    if (!bot) throw new Error("Bot not found.");

    const logPath = path.join(LOGS_DIR, `${botId}.log`);

    if (!fs.existsSync(logPath)) return "";

    return fs.readFileSync(logPath, "utf8")
        .split(/\r?\n/)
        .slice(-lines)
        .join("\n");
}


const CPU_CLOCK_TICKS = 100;
const cpuSamples = new Map();

function getBotResourceUsage(botId, ownerId) {
    const bot = getOwnedBot(botId, ownerId);

    if (!bot) throw new Error("Bot not found.");

    const record = processes.get(botId);

    if (!record) {
        return {
            botId,
            status: bot.status,
            running: false,
            pid: null,
            cpuPercent: null,
            memoryMB: null,
            uptimeSeconds: null
        };
    }

    const pid = record.child.pid;

    try {
        const stat = fs.readFileSync(
            `/proc/${pid}/stat`,
            "utf8"
        );

        const end = stat.lastIndexOf(")");
        const fields = stat.slice(end + 2).trim().split(/\s+/);

        const userTicks = Number(fields[11]);
        const systemTicks = Number(fields[12]);

        const totalTicks = userTicks + systemTicks;

        const now = process.hrtime.bigint();
        const previous = cpuSamples.get(botId);

        let cpuPercent = null;

        if (previous) {
            const elapsedSeconds =
                Number(now - previous.time) / 1e9;

            const tickDifference =
                totalTicks - previous.ticks;

            if (elapsedSeconds > 0 && tickDifference >= 0) {
                cpuPercent =
                    (tickDifference / CPU_CLOCK_TICKS) /
                    elapsedSeconds * 100;
            }
        }

        cpuSamples.set(botId, {
            ticks: totalTicks,
            time: now
        });

        const status = fs.readFileSync(
            `/proc/${pid}/status`,
            "utf8"
        );

        const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB/m);

        if (!rssMatch) {
            throw new Error("Unable to read process memory.");
        }

        const memoryMB = Number(rssMatch[1]) / 1024;

        const uptimeSeconds = Math.floor(
            (Date.now() - Date.parse(record.startedAt)) / 1000
        );

        return {
            botId,
            name: bot.name,
            status: "running",
            running: true,
            pid,
            cpuPercent: cpuPercent === null
                ? null
                : Number(cpuPercent.toFixed(2)),
            memoryMB: Number(memoryMB.toFixed(2)),
            uptimeSeconds
        };

    } catch (error) {
        if (error.code === "ENOENT") {
            return {
                botId,
                status: "unavailable",
                running: false,
                pid,
                cpuPercent: null,
                memoryMB: null,
                uptimeSeconds: null
            };
        }

        throw error;
    }
}

function recoverStaleBots() {
    db.prepare(`
        UPDATE bots
        SET status = 'crashed', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'
    `).run();

    db.prepare(`
        UPDATE deployments
        SET status = 'failed',
            finished_at = CURRENT_TIMESTAMP,
            error_message = 'NEXHOST restarted while this deployment was running.'
        WHERE status IN ('starting', 'running')
    `).run();
}

async function stopAll() {
    const botIds = [...processes.keys()];

    const results = await Promise.allSettled(
        botIds.map(async botId => {
            const bot = db.prepare(
                "SELECT owner_id FROM bots WHERE id = ?"
            ).get(botId);

            if (!bot) {
                throw new Error(`Bot ${botId} was not found during shutdown.`);
            }

            return stopBot(botId, bot.owner_id);
        })
    );

    let stopped = 0;
    let failed = 0;

    for (const result of results) {
        if (result.status === "fulfilled") {
            stopped++;
        } else {
            failed++;
            console.error("[SHUTDOWN] Failed to stop bot:", result.reason);
        }
    }

    return { stopped, failed };
}

module.exports = {
    startBot,
    stopBot,
    getBotStatus,
    getBotLogs,
    getBotResourceUsage,
    recoverStaleBots,
    stopAll
};

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { db } = require("../../database/db");

const BOTS_DIR = path.resolve(__dirname, "../../storage/bots");
const LOGS_DIR = path.resolve(__dirname, "../../storage/logs");

const DOCKER_IMAGE = process.env.NEXHOST_DOCKER_IMAGE || "node:22-alpine";
const MEMORY_LIMIT = process.env.DOCKER_BOT_MEMORY || "512m";
const CPU_LIMIT = process.env.DOCKER_BOT_CPUS || "1";
const PID_LIMIT = Number(process.env.DOCKER_BOT_PIDS || 128);
const OLD_SPACE_MB = Number(process.env.BOT_MAX_OLD_SPACE_MB || 256);

const containers = new Map();

fs.mkdirSync(LOGS_DIR, { recursive: true });

function validateResourceConfig() {
    const memoryMatch = MEMORY_LIMIT.match(/^(\d+)([bBkKmMgG])$/);
    const memoryBytes = memoryMatch
        ? Number(memoryMatch[1]) * ({
            b: 1,
            k: 1024,
            m: 1024 ** 2,
            g: 1024 ** 3
        })[memoryMatch[2].toLowerCase()]
        : NaN;

    if (
        !Number.isFinite(memoryBytes) ||
        memoryBytes < 64 * 1024 ** 2 ||
        memoryBytes > 64 * 1024 ** 3
    ) {
        throw new Error("Invalid DOCKER_BOT_MEMORY setting. Use 64m–64g.");
    }

    const cpus = Number(CPU_LIMIT);

    if (!Number.isFinite(cpus) || cpus < 0.1 || cpus > 64) {
        throw new Error("Invalid DOCKER_BOT_CPUS setting. Use 0.1–64.");
    }
}

function validateBotId(id) {
    if (
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ) {
        throw new Error("Invalid bot ID.");
    }
}

function containerName(botId) {
    validateBotId(botId);
    return `nexhost-bot-${botId}`;
}

function docker(args, options = {}) {
    const result = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: options.timeout || 30000,
        maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
        windowsHide: true
    });

    if (result.error) {
        throw new Error(`Docker execution failed: ${result.error.message}`);
    }

    if (result.status !== 0) {
        throw new Error(
            (result.stderr || result.stdout || "Docker command failed.").trim()
        );
    }

    return (result.stdout || "").trim();
}

function networkName(botId) {
    validateBotId(botId);
    return `nexhost-net-${botId}`;
}

function ensureDockerNetwork(botId) {
    const network = networkName(botId);

    try {
        docker(["network", "inspect", network]);
    } catch {
        docker([
            "network", "create",
            "--driver", "bridge",
            "--opt", "com.docker.network.bridge.enable_icc=false",
            "--label", "com.nexhost.managed=true",
            "--label", `com.nexhost.bot-id=${botId}`,
            network
        ]);
    }
}

function removeDockerNetwork(botId) {
    try {
        docker(["network", "rm", networkName(botId)]);
    } catch (error) {
        if (!/no such network|not found/i.test(error.message)) {
            throw error;
        }
    }
}

function getOwnedBot(botId, ownerId) {
    validateBotId(botId);

    const bot = db.prepare(`
        SELECT id, owner_id, name, runtime, entry_file, status
        FROM bots
        WHERE id = ? AND owner_id = ?
    `).get(botId, ownerId);

    if (!bot) throw new Error("Bot not found.");

    return bot;
}

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
        options.started ? 1 : 0,
        options.finished ? 1 : 0,
        options.started ? 1 : 0,
        options.error || null,
        deployment.id
    );
}

function inspectContainer(botId) {
    try {
        const output = docker([
            "inspect",
            containerName(botId)
        ]);

        const result = JSON.parse(output);
        return result[0] || null;
    } catch (error) {
        if (/no such object|no such container/i.test(error.message)) {
            return null;
        }

        throw error;
    }
}

function resolveBotEntry(bot) {
    const botDir = path.resolve(BOTS_DIR, bot.id);
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

    return {
        botDir: realBotDir,
        entryFile: `/app/${relativeEntry.split(path.sep).join("/")}`
    };
}

function finalizeContainer(botId, container) {
    if (!container || container.State.Running) return;

    containers.delete(botId);

    const successful = container.State.ExitCode === 0;
    const status = successful ? "stopped" : "crashed";
    const deploymentStatus = successful ? "stopped" : "failed";

    const error = successful
        ? null
        : `Docker container exited unexpectedly. Exit code: ${container.State.ExitCode}`;

    updateStatus(botId, status);
    updateLatestDeployment(botId, deploymentStatus, {
        finished: true,
        error
    });
}

async function startBot(botId, ownerId) {
    validateResourceConfig();

    const bot = getOwnedBot(botId, ownerId);

    const existing = inspectContainer(botId);

    if (existing && existing.State.Running) {
        throw new Error("Bot is already running.");
    }

    if (existing) {
        docker(["rm", "-f", containerName(botId)]);
    }

    const { botDir, entryFile } = resolveBotEntry(bot);

    if (
        !Number.isSafeInteger(OLD_SPACE_MB) ||
        OLD_SPACE_MB < 64 ||
        OLD_SPACE_MB > 2048
    ) {
        throw new Error("Invalid BOT_MAX_OLD_SPACE_MB setting.");
    }

    if (
        !Number.isSafeInteger(PID_LIMIT) ||
        PID_LIMIT < 16 ||
        PID_LIMIT > 4096
    ) {
        throw new Error("Invalid DOCKER_BOT_PIDS setting.");
    }

    updateLatestDeployment(botId, "starting", { started: true });

    try {
        ensureDockerNetwork(botId);
        docker([
            "run",
            "-d",
            "--pull=missing",
            "--name", containerName(botId),
            "--label", "com.nexhost.managed=true",
            "--label", `com.nexhost.bot-id=${botId}`,
            "--restart=no",
            "--user", "10001:10001",
            "--memory", MEMORY_LIMIT,
            "--memory-swap", MEMORY_LIMIT,
            "--cpus", CPU_LIMIT,
            "--pids-limit", String(PID_LIMIT),
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--network", networkName(botId),
            "--log-driver=json-file",
            "--log-opt", "max-size=1m",
            "--log-opt", "max-file=2",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,uid=10001,gid=10001",
            "--tmpfs", "/home/nexhost:rw,nosuid,nodev,size=64m,uid=10001,gid=10001",
            "--mount", `type=bind,source=${botDir},target=/app,readonly`,
            "--workdir", "/app",
            DOCKER_IMAGE,
            `--max-old-space-size=${OLD_SPACE_MB}`,
            entryFile
        ], { timeout: 120000 });

        const container = inspectContainer(botId);

        if (!container || !container.State.Running) {
            throw new Error("Docker container failed to start.");
        }

        containers.set(botId, true);

        updateStatus(botId, "running");
        updateLatestDeployment(botId, "running");

        return {
            botId,
            pid: container.State.Pid,
            status: "running"
        };

    } catch (error) {
        try { removeDockerNetwork(botId); } catch (cleanupError) {
            console.error("[DOCKER NETWORK CLEANUP]", cleanupError.message);
        }
        updateStatus(botId, "crashed");
        updateLatestDeployment(botId, "failed", {
            finished: true,
            error: error.message
        });

        throw new Error(`Unable to start bot: ${error.message}`);
    }
}

async function stopBot(botId, ownerId) {
    getOwnedBot(botId, ownerId);

    const container = inspectContainer(botId);

    if (container && container.State.Running) {
        docker([
            "stop",
            "--time", "5",
            containerName(botId)
        ]);

        docker(["rm", containerName(botId)]);
    } else if (container) {
        docker(["rm", containerName(botId)]);
    }

    removeDockerNetwork(botId);
    containers.delete(botId);
    updateStatus(botId, "stopped");
    updateLatestDeployment(botId, "stopped", { finished: true });

    return { botId, status: "stopped" };
}

function getBotStatus(botId, ownerId) {
    const bot = getOwnedBot(botId, ownerId);
    const container = inspectContainer(botId);

    if (!container) {
        containers.delete(botId);

        return {
            botId,
            name: bot.name,
            status: bot.status,
            pid: null,
            startedAt: null
        };
    }

    if (!container.State.Running) {
        finalizeContainer(botId, container);
    } else {
        containers.set(botId, true);
        updateStatus(botId, "running");
    }

    const currentStatus = container.State.Running
        ? "running"
        : (db.prepare("SELECT status FROM bots WHERE id = ?").get(botId)?.status || bot.status);

    return {
        botId,
        name: bot.name,
        status: currentStatus,
        pid: container.State.Running ? container.State.Pid : null,
        startedAt: container.State.StartedAt || null
    };
}

function getBotLogs(botId, ownerId, lines = 50) {
    getOwnedBot(botId, ownerId);

    const count = Math.max(1, Math.min(Number(lines) || 50, 500));

    try {
        return docker([
            "logs",
            "--tail", String(count),
            containerName(botId)
        ], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
        if (/no such container/i.test(error.message)) return "";
        throw error;
    }
}

function getBotResourceUsage(botId, ownerId) {
    const bot = getOwnedBot(botId, ownerId);
    const container = inspectContainer(botId);

    if (!container || !container.State.Running) {
        if (container) finalizeContainer(botId, container);

        const currentStatus = container
            ? (db.prepare("SELECT status FROM bots WHERE id = ?").get(botId)?.status || bot.status)
            : bot.status;

        return {
            botId,
            status: currentStatus,
            running: false,
            pid: null,
            cpuPercent: null,
            memoryMB: null,
            uptimeSeconds: null
        };
    }

    const output = docker([
        "stats",
        "--no-stream",
        "--format",
        "{{.CPUPerc}}|{{.MemUsage}}",
        containerName(botId)
    ], { timeout: 15000 });

    const [cpuText, memoryText] = output.split("|");

    const cpuPercent = Number.parseFloat(cpuText);
    const memoryMatch = memoryText && memoryText.match(/^([\d.]+)\s*(B|KiB|MiB|GiB)/i);

    const multipliers = {
        B: 1 / (1024 * 1024),
        KiB: 1 / 1024,
        MiB: 1,
        GiB: 1024
    };

    const memoryMB = memoryMatch
        ? Number(memoryMatch[1]) * multipliers[memoryMatch[2]]
        : null;

    const uptimeSeconds = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(container.State.StartedAt)) / 1000)
    );

    return {
        botId,
        name: bot.name,
        status: "running",
        running: true,
        pid: container.State.Pid,
        cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
        memoryMB: memoryMB === null ? null : Number(memoryMB.toFixed(2)),
        uptimeSeconds
    };
}

function recoverStaleBots() {
    const bots = db.prepare(`
        SELECT id, status FROM bots
        WHERE status = 'running'
    `).all();

    for (const bot of bots) {
        try {
            const container = inspectContainer(bot.id);

            if (container && container.State.Running) {
                containers.set(bot.id, true);
                continue;
            }

            if (container) {
                finalizeContainer(bot.id, container);
            } else {
                updateStatus(bot.id, "crashed");
                updateLatestDeployment(bot.id, "failed", {
                    finished: true,
                    error: "NEXHOST restarted and the Docker container was not found."
                });
            }
        } catch (error) {
            console.error(`[DOCKER RECOVERY] ${bot.id}:`, error.message);
        }
    }
}

async function stopAll() {
    const bots = db.prepare(`
        SELECT id, owner_id FROM bots
        WHERE status = 'running'
    `).all();

    const results = await Promise.allSettled(
        bots.map(bot => stopBot(bot.id, bot.owner_id))
    );

    let stopped = 0;
    let failed = 0;

    for (const result of results) {
        if (result.status === "fulfilled") {
            stopped++;
        } else {
            failed++;
            console.error("[DOCKER SHUTDOWN]", result.reason);
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

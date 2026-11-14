const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db } = require("../../database/db");

const STORAGE = path.resolve(__dirname, "../../storage");
const KEY_FILE = path.join(STORAGE, "config-encryption.key");

function encryptionKey() {
    fs.mkdirSync(STORAGE, { recursive: true, mode: 0o700 });

    if (!fs.existsSync(KEY_FILE)) {
        const temporary = KEY_FILE + "." + crypto.randomUUID() + ".tmp";
        fs.writeFileSync(temporary, crypto.randomBytes(32), {
            flag: "wx",
            mode: 0o600
        });

        try {
            fs.renameSync(temporary, KEY_FILE);
        } catch (error) {
            try { fs.unlinkSync(temporary); } catch {}
            if (!fs.existsSync(KEY_FILE)) throw error;
        }
    }

    const stat = fs.lstatSync(KEY_FILE);

    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Invalid NEXHOST configuration encryption key.");
    }

    fs.chmodSync(KEY_FILE, 0o600);

    const key = fs.readFileSync(KEY_FILE);

    if (key.length !== 32) {
        throw new Error("NEXHOST configuration encryption key is invalid.");
    }

    return key;
}

function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final()
    ]);

    return {
        iv: iv.toString("hex"),
        authTag: cipher.getAuthTag().toString("hex"),
        ciphertext: ciphertext.toString("hex")
    };
}

function decrypt(record) {
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        encryptionKey(),
        Buffer.from(record.iv, "hex")
    );

    decipher.setAuthTag(Buffer.from(record.auth_tag, "hex"));

    return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "hex")),
        decipher.final()
    ]).toString("utf8");
}

function validateKey(key) {
    return typeof key === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key);
}

function validateValue(value) {
    return typeof value === "string" &&
        value.length <= 8192 &&
        !value.includes("\0");
}

function getConfig(botId) {
    const bot = db.prepare(`
        SELECT startup_args FROM bots WHERE id = ?
    `).get(botId);

    if (!bot) throw new Error("Bot not found.");

    let startupArgs;

    try {
        startupArgs = JSON.parse(bot.startup_args || "[]");
    } catch {
        startupArgs = [];
    }

    const variables = db.prepare(`
        SELECT name FROM bot_environment_variables
        WHERE bot_id = ?
        ORDER BY name
    `).all(botId).map(row => row.name);

    return { startupArgs, environmentVariableNames: variables };
}

function updateStartupArgs(botId, args) {
    if (
        !Array.isArray(args) ||
        args.length > 32 ||
        args.some(value =>
            typeof value !== "string" ||
            value.length > 256 ||
            value.includes("\0")
        )
    ) {
        throw new Error("Startup arguments must be an array of at most 32 strings.");
    }

    const result = db.prepare(`
        UPDATE bots SET startup_args = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'stopped'
    `).run(JSON.stringify(args), botId);

    if (!result.changes) {
        const bot = db.prepare("SELECT id, status FROM bots WHERE id = ?").get(botId);
        if (!bot) throw new Error("Bot not found.");
        throw new Error("Stop the bot before changing startup settings.");
    }

    return getConfig(botId);
}

function setEnvironmentVariables(botId, variables) {
    if (
        !variables ||
        typeof variables !== "object" ||
        Array.isArray(variables)
    ) {
        throw new Error("Environment variables must be an object.");
    }

    const entries = Object.entries(variables);

    if (entries.length > 64) {
        throw new Error("A maximum of 64 environment variables is allowed per request.");
    }

    for (const [name, value] of entries) {
        if (!validateKey(name) || !validateValue(value)) {
            throw new Error(`Invalid environment variable: ${name}`);
        }

        if (/^(PATH|HOME|TMPDIR|NODE_OPTIONS|NODE_ENV)$/i.test(name)) {
            throw new Error(`The environment variable ${name} is reserved.`);
        }
    }

    const bot = db.prepare(`
        SELECT id, status FROM bots WHERE id = ?
    `).get(botId);

    if (!bot) throw new Error("Bot not found.");
    if (bot.status !== "stopped") {
        throw new Error("Stop the bot before changing environment variables.");
    }

    db.exec("BEGIN IMMEDIATE");

    try {
        const save = db.prepare(`
            INSERT INTO bot_environment_variables
                (bot_id, name, iv, auth_tag, ciphertext)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(bot_id, name) DO UPDATE SET
                iv = excluded.iv,
                auth_tag = excluded.auth_tag,
                ciphertext = excluded.ciphertext,
                updated_at = CURRENT_TIMESTAMP
        `);

        for (const [name, value] of entries) {
            const encrypted = encrypt(value);
            save.run(
                botId,
                name,
                encrypted.iv,
                encrypted.authTag,
                encrypted.ciphertext
            );
        }

        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }

    return getConfig(botId);
}

function deleteEnvironmentVariable(botId, name) {
    if (!validateKey(name)) throw new Error("Invalid environment variable name.");

    const bot = db.prepare(`
        SELECT id, status FROM bots WHERE id = ?
    `).get(botId);

    if (!bot) throw new Error("Bot not found.");
    if (bot.status !== "stopped") {
        throw new Error("Stop the bot before changing environment variables.");
    }

    db.prepare(`
        DELETE FROM bot_environment_variables
        WHERE bot_id = ? AND name = ?
    `).run(botId, name);

    return getConfig(botId);
}

function getRuntimeConfig(botId) {
    const bot = db.prepare(`
        SELECT startup_args FROM bots WHERE id = ?
    `).get(botId);

    if (!bot) throw new Error("Bot not found.");

    const rows = db.prepare(`
        SELECT name, iv, auth_tag, ciphertext
        FROM bot_environment_variables
        WHERE bot_id = ?
    `).all(botId);

    const environment = {};

    for (const row of rows) {
        environment[row.name] = decrypt(row);
    }

    return {
        startupArgs: JSON.parse(bot.startup_args || "[]"),
        environment
    };
}

module.exports = {
    getConfig,
    updateStartupArgs,
    setEnvironmentVariables,
    deleteEnvironmentVariable,
    getRuntimeConfig
};

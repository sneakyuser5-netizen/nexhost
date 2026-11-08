const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { db } = require("../../database/db");

const scrypt = promisify(crypto.scrypt);

const SCRYPT_OPTIONS = {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
};

async function hashPassword(password) {
    if (typeof password !== "string" || password.length < 10 || password.length > 128) {
        throw new Error("Invalid password length.");
    }

    const salt = crypto.randomBytes(16).toString("hex");

    const hash = await scrypt(
        password,
        salt,
        64,
        SCRYPT_OPTIONS
    );

    return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
    try {
        if (
            typeof password !== "string" ||
            password.length === 0 ||
            password.length > 128 ||
            typeof storedHash !== "string"
        ) {
            return false;
        }

        const parts = storedHash.split(":");

        if (parts.length !== 2) return false;

        const [salt, originalHash] = parts;

        if (
            !/^[a-f0-9]{32}$/i.test(salt) ||
            !/^[a-f0-9]{128}$/i.test(originalHash)
        ) {
            return false;
        }

        const hash = await scrypt(
            password,
            salt,
            64,
            SCRYPT_OPTIONS
        );

        const originalBuffer = Buffer.from(originalHash, "hex");

        return crypto.timingSafeEqual(hash, originalBuffer);

    } catch (error) {
        console.error("[PASSWORD VERIFY]", error.message);
        return false;
    }
}

function hashToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

function createSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);

    const id = crypto.randomUUID();

    const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    db.prepare(`
        INSERT INTO sessions (
            id,
            user_id,
            token_hash,
            expires_at
        )
        VALUES (?, ?, ?, ?)
    `).run(id, userId, tokenHash, expiresAt);

    return {
        token,
        expiresAt
    };
}

function findSession(token) {
    const tokenHash = hashToken(token);

    return db.prepare(`
        SELECT
            sessions.id AS session_id,
            sessions.user_id,
            users.email,
            users.role
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
        AND sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > datetime('now')
    `).get(tokenHash);
}

function revokeSession(token) {
    const tokenHash = hashToken(token);

    return db.prepare(`
        UPDATE sessions
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE token_hash = ?
        AND revoked_at IS NULL
    `).run(tokenHash);
}

function cleanupExpiredSessions() {
    return db.prepare(`
        DELETE FROM sessions
        WHERE revoked_at IS NOT NULL
        OR datetime(expires_at) <= datetime('now')
    `).run();
}

module.exports = {
    hashPassword,
    verifyPassword,
    createSession,
    findSession,
    revokeSession,
    cleanupExpiredSessions
};

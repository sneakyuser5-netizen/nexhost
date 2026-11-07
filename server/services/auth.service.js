const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { db } = require("../../database/db");

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");

    const hash = await scrypt(password, salt, 64);

    return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
    const [salt, originalHash] = storedHash.split(":");

    if (!salt || !originalHash) return false;

    const hash = await scrypt(password, salt, 64);

    const originalBuffer = Buffer.from(originalHash, "hex");

    if (hash.length !== originalBuffer.length) return false;

    return crypto.timingSafeEqual(hash, originalBuffer);
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

module.exports = {
    hashPassword,
    verifyPassword,
    createSession,
    findSession,
    revokeSession
};

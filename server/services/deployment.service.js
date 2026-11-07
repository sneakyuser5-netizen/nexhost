const crypto = require("node:crypto");
const { db } = require("../../database/db");

function recordUpload(botId, buffer, uploadResult) {
    const hash = crypto
        .createHash("sha256")
        .update(buffer)
        .digest("hex");

    db.exec("BEGIN IMMEDIATE");

    try {
        const latest = db.prepare(`
            SELECT COALESCE(MAX(version), 0) AS version
            FROM deployments
            WHERE bot_id = ?
        `).get(botId);

        const version = latest.version + 1;
        const id = crypto.randomUUID();

        db.prepare(`
            INSERT INTO deployments (
                id,
                bot_id,
                version,
                status,
                source_type,
                source_ref
            )
            VALUES (?, ?, ?, 'queued', 'upload', ?)
        `).run(
            id,
            botId,
            version,
            `sha256:${hash}`
        );

        db.exec("COMMIT");

        return {
            id,
            botId,
            version,
            status: "queued",
            sourceType: "upload",
            archiveHash: hash,
            files: uploadResult.files,
            extractedBytes: uploadResult.extractedBytes
        };

    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function listDeployments(botId) {
    return db.prepare(`
        SELECT
            id,
            bot_id,
            version,
            status,
            source_type,
            source_ref,
            started_at,
            finished_at,
            error_message,
            created_at
        FROM deployments
        WHERE bot_id = ?
        ORDER BY version DESC
    `).all(botId);
}

module.exports = {
    recordUpload,
    listDeployments
};

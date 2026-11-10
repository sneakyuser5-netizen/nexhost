const crypto = require("node:crypto");
const { db } = require("../../database/db");

function createDeployment(botId, options = {}) {
    const {
        sourceType = "upload",
        archiveHash,
        rollbackOf = null
    } = options;

    if (!archiveHash || !/^[a-f0-9]{64}$/.test(archiveHash)) {
        throw new Error("Invalid deployment archive hash.");
    }

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
                source_ref,
                rollback_of
            )
            VALUES (?, ?, ?, 'queued', ?, ?, ?)
        `).run(
            id,
            botId,
            version,
            sourceType,
            `sha256:${archiveHash}`,
            rollbackOf
        );

        db.exec("COMMIT");

        return {
            id,
            botId,
            version,
            status: "queued",
            sourceType,
            archiveHash,
            rollbackOf
        };

    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function createUploadDeployment(botId, buffer) {
    const archiveHash = crypto
        .createHash("sha256")
        .update(buffer)
        .digest("hex");

    return createDeployment(botId, {
        sourceType: "upload",
        archiveHash
    });
}

function createRollbackDeployment(botId, sourceDeployment) {
    if (!sourceDeployment || sourceDeployment.bot_id !== botId) {
        throw new Error("Invalid rollback source deployment.");
    }

    const match = String(sourceDeployment.source_ref || "")
        .match(/^sha256:([a-f0-9]{64})$/);

    if (!match) {
        throw new Error("Source deployment has no valid archive hash.");
    }

    return createDeployment(botId, {
        sourceType: "upload",
        archiveHash: match[1],
        rollbackOf: sourceDeployment.id
    });
}

function markDeploymentFailed(deploymentId, error) {
    db.prepare(`
        UPDATE deployments
        SET status = 'failed',
            finished_at = CURRENT_TIMESTAMP,
            error_message = ?
        WHERE id = ?
    `).run(
        String(error?.message || error || "Deployment failed").slice(0, 1000),
        deploymentId
    );
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
            rollback_of,
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
    createUploadDeployment,
    createRollbackDeployment,
    markDeploymentFailed,
    listDeployments
};

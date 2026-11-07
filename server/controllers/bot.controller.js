const crypto = require("node:crypto");
const { db } = require("../../database/db");
const deploymentService = require("../services/deployment.service");

const botFields = `
    id,
    owner_id,
    name,
    runtime,
    entry_file,
    status,
    created_at,
    updated_at
`;

function createBot(req, res) {
    try {
        const { name, entryFile = "index.js", runtime = "node" } = req.body;

        if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{3,32}$/.test(name)) {
            return res.status(400).json({
                success: false,
                message: "Bot name must contain 3-32 letters, numbers, underscores or hyphens."
            });
        }

        if (runtime !== "node") {
            return res.status(400).json({
                success: false,
                message: "Only Node.js runtime is currently supported."
            });
        }

        if (
            typeof entryFile !== "string" ||
            !/^[a-zA-Z0-9_-]+\.([cm]?js)$/.test(entryFile)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid entry file. Use a JavaScript filename such as index.js."
            });
        }

        const id = crypto.randomUUID();

        db.prepare(`
            INSERT INTO bots (
                id,
                owner_id,
                name,
                runtime,
                entry_file
            )
            VALUES (?, ?, ?, ?, ?)
        `).run(
            id,
            req.user.id,
            name,
            runtime,
            entryFile
        );

        const bot = db.prepare(`
            SELECT ${botFields}
            FROM bots
            WHERE id = ? AND owner_id = ?
        `).get(id, req.user.id);

        return res.status(201).json({
            success: true,
            message: "Bot created successfully.",
            bot
        });

    } catch (error) {
        if (error.code === "ERR_SQLITE_ERROR" && error.message.includes("UNIQUE")) {
            return res.status(409).json({
                success: false,
                message: "You already have a bot with this name."
            });
        }

        console.error("[BOT CREATE]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to create bot."
        });
    }
}

function listBots(req, res) {
    try {
        const bots = db.prepare(`
            SELECT ${botFields}
            FROM bots
            WHERE owner_id = ?
            ORDER BY created_at DESC
        `).all(req.user.id);

        return res.json({
            success: true,
            count: bots.length,
            bots
        });

    } catch (error) {
        console.error("[BOT LIST]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to retrieve bots."
        });
    }
}

function getBot(req, res) {
    try {
        const bot = db.prepare(`
            SELECT ${botFields}
            FROM bots
            WHERE id = ? AND owner_id = ?
        `).get(req.params.id, req.user.id);

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: "Bot not found."
            });
        }

        return res.json({
            success: true,
            bot
        });

    } catch (error) {
        console.error("[BOT GET]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to retrieve bot."
        });
    }
}

function updateBot(req, res) {
    try {
        const { name, entryFile } = req.body;

        if (name === undefined && entryFile === undefined) {
            return res.status(400).json({
                success: false,
                message: "Provide a name or entryFile to update."
            });
        }

        if (
            name !== undefined &&
            (typeof name !== "string" || !/^[a-zA-Z0-9_-]{3,32}$/.test(name))
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid bot name."
            });
        }

        if (
            entryFile !== undefined &&
            (typeof entryFile !== "string" ||
            !/^[a-zA-Z0-9_-]+\.([cm]?js)$/.test(entryFile))
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid entry file."
            });
        }

        const existing = db.prepare(`
            SELECT id FROM bots
            WHERE id = ? AND owner_id = ?
        `).get(req.params.id, req.user.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Bot not found."
            });
        }

        if (name !== undefined && entryFile !== undefined) {
            db.prepare(`
                UPDATE bots
                SET name = ?, entry_file = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND owner_id = ?
            `).run(name, entryFile, req.params.id, req.user.id);

        } else if (name !== undefined) {
            db.prepare(`
                UPDATE bots
                SET name = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND owner_id = ?
            `).run(name, req.params.id, req.user.id);

        } else {
            db.prepare(`
                UPDATE bots
                SET entry_file = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND owner_id = ?
            `).run(entryFile, req.params.id, req.user.id);
        }

        const bot = db.prepare(`
            SELECT ${botFields}
            FROM bots
            WHERE id = ? AND owner_id = ?
        `).get(req.params.id, req.user.id);

        return res.json({
            success: true,
            message: "Bot updated successfully.",
            bot
        });

    } catch (error) {
        if (error.code === "ERR_SQLITE_ERROR" && error.message.includes("UNIQUE")) {
            return res.status(409).json({
                success: false,
                message: "A bot with this name already exists."
            });
        }

        console.error("[BOT UPDATE]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to update bot."
        });
    }
}

function deleteBot(req, res) {
    try {
        const result = db.prepare(`
            DELETE FROM bots
            WHERE id = ? AND owner_id = ?
        `).run(req.params.id, req.user.id);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: "Bot not found."
            });
        }

        return res.json({
            success: true,
            message: "Bot deleted successfully."
        });

    } catch (error) {
        console.error("[BOT DELETE]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to delete bot."
        });
    }
}

module.exports = {
    createBot,
    listBots,
    getBot,
    updateBot,
    deleteBot,
    uploadBotFiles,
    listDeployments
};

async function uploadBotFiles(req, res) {
    try {
        const bot = db.prepare(`
            SELECT id, owner_id, entry_file, status
            FROM bots
            WHERE id = ? AND owner_id = ?
        `).get(req.params.id, req.user.id);

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: "Bot not found."
            });
        }

        if (bot.status === "running") {
            return res.status(409).json({
                success: false,
                message: "Stop the bot before replacing its source files."
            });
        }

        const { uploadBotArchive } = require("../services/bot-upload.service");

        const result = await uploadBotArchive(bot, req.file.buffer);

        const deployment = deploymentService.recordUpload(
            bot.id,
            req.file.buffer,
            result
        );

        db.prepare(`
            UPDATE bots
            SET updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND owner_id = ?
        `).run(bot.id, req.user.id);

        return res.json({
            success: true,
            message: "Bot source uploaded and deployment recorded.",
            upload: {
                botId: bot.id,
                files: result.files,
                extractedBytes: result.extractedBytes
            },
            deployment
        });

    } catch (error) {
        console.error("[BOT UPLOAD]", error.message);

        return res.status(400).json({
            success: false,
            message: error.message || "Unable to upload bot source."
        });
    }
}


function listDeployments(req, res) {
    try {
        const bot = db.prepare(`
            SELECT id
            FROM bots
            WHERE id = ? AND owner_id = ?
        `).get(req.params.id, req.user.id);

        if (!bot) {
            return res.status(404).json({
                success: false,
                message: "Bot not found."
            });
        }

        const deployments = deploymentService.listDeployments(bot.id);

        return res.json({
            success: true,
            botId: bot.id,
            count: deployments.length,
            deployments
        });

    } catch (error) {
        console.error("[DEPLOYMENT LIST]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to retrieve deployment history."
        });
    }
}

const { db } = require("../../database/db");
const manager = require("../services/file-manager.service");

function ownedBot(req) {
    return db.prepare(`
        SELECT id FROM bots
        WHERE id = ? AND owner_id = ?
    `).get(req.params.id, req.user.id);
}

function respondError(res, error) {
    const known = [
        "Invalid bot ID.",
        "Invalid bot directory.",
        "Invalid file path.",
        "Invalid or restricted path.",
        "Invalid or restricted name.",
        "Path outside bot directory.",
        "Symbolic links are not accessible.",
        "Cannot delete bot root.",
        "Invalid rename operation.",
        "File path required.",
        "Folder path required.",
        "Path required.",
        "File content must be a string.",
        "Invalid file content.",
        "Invalid upload.",
        "Not a directory.",
        "Not a file.",
        "Not a regular file.",
        "Binary file cannot be edited.",
        "File is not valid UTF-8 text.",
        "File exceeds the 1 MB editor limit.",
        "File exceeds the 1 MB editor limit.",
        "File exceeds the 1 MB editor limit."
    ];

    const status = error.code === "ENOENT" ? 404
        : error.code === "EEXIST" ? 409
        : known.includes(error.message) ? 400
        : 500;

    return res.status(status).json({
        success: false,
        message: status === 500
            ? "File Manager operation failed."
            : error.message
    });
}

function requireBot(req, res) {
    const bot = ownedBot(req);

    if (!bot) {
        res.status(404).json({
            success: false,
            message: "Bot not found."
        });
        return null;
    }

    return bot;
}

async function list(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        res.json({
            success: true,
            ...await manager.listFiles(bot.id, req.query.path || "")
        });
    } catch (error) {
        respondError(res, error);
    }
}

async function read(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        res.json({
            success: true,
            file: await manager.readFile(bot.id, req.query.path)
        });
    } catch (error) {
        respondError(res, error);
    }
}

async function save(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        await manager.writeFile(bot.id, req.body.path, req.body.content);
        res.json({ success: true, message: "File saved successfully." });
    } catch (error) {
        respondError(res, error);
    }
}

async function create(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        await manager.writeFile(
            bot.id,
            req.body.path,
            req.body.content || "",
            true
        );

        res.json({ success: true, message: "File created." });
    } catch (error) {
        respondError(res, error);
    }
}

async function folder(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        await manager.createFolder(bot.id, req.body.path);
        res.json({ success: true, message: "Folder created." });
    } catch (error) {
        respondError(res, error);
    }
}

async function upload(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Choose a file to upload."
            });
        }

        await manager.uploadFile(
            bot.id,
            req.body.path || "",
            req.file.originalname,
            req.file.buffer
        );

        res.json({ success: true, message: "File uploaded." });
    } catch (error) {
        respondError(res, error);
    }
}

async function download(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        const result = await manager.downloadFile(bot.id, req.query.path);

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`
        );
        res.send(result.buffer);
    } catch (error) {
        respondError(res, error);
    }
}

async function rename(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        await manager.renameFile(
            bot.id,
            req.body.path,
            req.body.newName
        );

        res.json({ success: true, message: "Renamed successfully." });
    } catch (error) {
        respondError(res, error);
    }
}

async function remove(req, res) {
    try {
        const bot = requireBot(req, res);
        if (!bot) return;

        await manager.deleteFile(bot.id, req.query.path);

        res.json({ success: true, message: "Deleted successfully." });
    } catch (error) {
        respondError(res, error);
    }
}

module.exports = {
    list,
    read,
    save,
    create,
    folder,
    upload,
    download,
    rename,
    remove
};

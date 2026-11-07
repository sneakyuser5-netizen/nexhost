const manager = require("../services/process-manager");

function handleError(res, error) {
    const status = error.message === "Bot not found." ? 404 : 400;

    return res.status(status).json({
        success: false,
        message: error.message || "Process operation failed."
    });
}

async function start(req, res) {
    try {
        const result = await manager.startBot(req.params.id, req.user.id);

        return res.json({
            success: true,
            message: "Bot started successfully.",
            process: result
        });
    } catch (error) {
        return handleError(res, error);
    }
}

async function stop(req, res) {
    try {
        const result = await manager.stopBot(req.params.id, req.user.id);

        return res.json({
            success: true,
            message: "Bot stopped successfully.",
            process: result
        });
    } catch (error) {
        return handleError(res, error);
    }
}

function status(req, res) {
    try {
        return res.json({
            success: true,
            process: manager.getBotStatus(req.params.id, req.user.id)
        });
    } catch (error) {
        return handleError(res, error);
    }
}

function logs(req, res) {
    try {
        const result = manager.getBotLogs(
            req.params.id,
            req.user.id
        );

        return res.json({
            success: true,
            botId: req.params.id,
            logs: result
        });
    } catch (error) {
        return handleError(res, error);
    }
}

module.exports = { start, stop, status, logs };

module.exports.restart = async function(req, res) {
    try {
        await manager.stopBot(req.params.id, req.user.id);
        const result = await manager.startBot(req.params.id, req.user.id);

        return res.json({
            success: true,
            message: "Bot restarted successfully.",
            process: result
        });
    } catch (error) {
        return handleError(res, error);
    }
};

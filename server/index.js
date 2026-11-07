require("dotenv").config();

const { closeDatabase } = require("../database/db");
const app = require("./app");
const manager = require("./services/process-manager");

manager.recoverStaleBots();

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`
╔══════════════════════════════════╗
║          NEXHOST v0.3.0          ║
║                                  ║
║       Hosting Engine Ready       ║
║                                  ║
║  Server: http://127.0.0.1:${PORT}  ║
╚══════════════════════════════════╝
    `);
});

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;

    console.log(`\n[NEXHOST] ${signal} received. Shutting down...`);

    server.close();

    if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
    }

    try {
        const result = await manager.stopAll();

        console.log(
            `[NEXHOST] Bot shutdown complete. Stopped: ${result.stopped}, Failed: ${result.failed}`
        );
    } catch (error) {
        console.error("[NEXHOST] Shutdown error:", error);
    }

    try {
        closeDatabase();
        console.log("[NEXHOST] Database connection closed.");
    } catch (error) {
        console.error("[NEXHOST] Database close error:", error);
    }

    process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

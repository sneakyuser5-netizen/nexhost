require("dotenv").config();

const app = require("./app");

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`
╔══════════════════════════════════╗
║          NEXHOST v0.1.0          ║
║                                  ║
║       Hosting Engine Ready       ║
║                                  ║
║  Server: http://127.0.0.1:${PORT}  ║
╚══════════════════════════════════╝
    `);
});

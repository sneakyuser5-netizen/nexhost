const express = require("express");
const helmet = require("helmet");

const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
    res.json({
        name: "NEXHOST",
        description: "Universal Node.js Bot Hosting Platform",
        version: "0.1.0",
        status: "operational"
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        message: "NEXHOST API is running",
        timestamp: new Date().toISOString()
    });
});

module.exports = app;

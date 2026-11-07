const express = require("express");
const helmet = require("helmet");

const app = express();

const authRoutes = require("./routes/auth.routes");
const botRoutes = require("./routes/bot.routes");

app.use(helmet());

app.use(express.json({
    limit: "1mb"
}));

app.get("/", (req, res) => {
    res.json({
        name: "NEXHOST",
        description: "Universal Node.js Bot Hosting Platform",
        version: "0.3.0",
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

app.use("/api/auth", authRoutes);
app.use("/api/bots", botRoutes);

module.exports = app;

const express = require("express");
const helmet = require("helmet");
const path = require("node:path");

const { apiLimiter } = require("./middleware/rate-limit");

const app = express();

const authRoutes = require("./routes/auth.routes");
const botRoutes = require("./routes/bot.routes");

app.disable("x-powered-by");

app.use(helmet());

app.use(express.json({
    limit: "1mb"
}));

app.use("/api", apiLimiter);

app.use(express.static(path.resolve(__dirname, "../public")));

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

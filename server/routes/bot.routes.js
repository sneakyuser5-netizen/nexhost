const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/auth");
const botController = require("../controllers/bot.controller");
const processController = require("../controllers/process.controller");
const uploadBotFile = require("../middleware/bot-upload");
const { uploadLimiter } = require("../middleware/rate-limit");

router.use(authenticate);

router.post("/", botController.createBot);
router.post("/:id/upload", uploadLimiter, uploadBotFile, botController.uploadBotFiles);

router.post("/:id/start", processController.start);
router.post("/:id/stop", processController.stop);
router.post("/:id/restart", processController.restart);
router.post("/:id/rollback/:deploymentId", botController.rollbackDeployment);

router.get("/", botController.listBots);
router.get("/:id", botController.getBot);
router.get("/:id/config", botController.getBotConfig);
router.put("/:id/config/startup", botController.updateBotStartupConfig);
router.put("/:id/config/environment", botController.updateBotEnvironment);
router.delete("/:id/config/environment/:name", botController.deleteBotEnvironment);

router.get("/:id/status", processController.status);
router.get("/:id/resources", processController.resources);
router.get("/:id/deployments", botController.listDeployments);
router.get("/:id/logs", processController.logs);

router.patch("/:id", botController.updateBot);
router.delete("/:id", botController.deleteBot);

module.exports = router;

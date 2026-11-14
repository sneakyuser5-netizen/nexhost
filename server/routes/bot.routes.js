const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/auth");
const botController = require("../controllers/bot.controller");
const fileManager = require("../controllers/file-manager.controller");
const multer = require("multer");
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
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

router.get("/:id/files", fileManager.list);
router.get("/:id/file", fileManager.read);
router.get("/:id/file/download", fileManager.download);
router.put("/:id/file", fileManager.save);
router.post("/:id/files/create", fileManager.create);
router.post("/:id/files/folder", fileManager.folder);
router.post("/:id/files/upload", fileUpload.single("file"), fileManager.upload);
router.patch("/:id/file", fileManager.rename);
router.delete("/:id/file", fileManager.remove);




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

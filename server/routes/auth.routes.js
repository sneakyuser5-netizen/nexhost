const express = require("express");

const router = express.Router();

const authController = require("../controllers/auth.controller");
const authenticate = require("../middleware/auth");
const { authLimiter } = require("../middleware/rate-limit");

router.post("/register", authLimiter, authController.register);

router.post("/login", authLimiter, authController.login);

router.get("/me", authenticate, authController.me);

router.post("/logout", authenticate, authController.logout);

module.exports = router;

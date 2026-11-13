const express = require("express");
const router = express.Router();

const authController = require("../controllers/auth.controller");
const authenticate = require("../middleware/auth");

const {
    authLimiter,
    passwordResetLimiter
} = require("../middleware/rate-limit");

router.post("/register", authLimiter, authController.register);
router.post("/login", authLimiter, authController.login);

router.get("/me", authenticate, authController.me);
router.post("/logout", authenticate, authController.logout);

router.post(
    "/change-password",
    authenticate,
    authLimiter,
    authController.changePassword
);

router.post(
    "/forgot-password",
    passwordResetLimiter,
    authController.forgotPassword
);

router.post(
    "/reset-password",
    passwordResetLimiter,
    authController.resetPassword
);

module.exports = router;

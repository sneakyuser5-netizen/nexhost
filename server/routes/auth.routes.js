const express = require("express");
const router = express.Router();

const authController = require("../controllers/auth.controller");
const authenticate = require("../middleware/auth");

const {
    authLimiter,
    passwordResetLimiter,
    emailVerificationLimiter,
    verificationResendLimiter
} = require("../middleware/rate-limit");

router.post("/register", authLimiter, authController.register);
router.post("/login", authLimiter, authController.login);

router.post(
    "/verify-email",
    emailVerificationLimiter,
    authController.verifyEmail
);

router.post(
    "/resend-verification",
    verificationResendLimiter,
    authController.resendVerificationCode
);

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

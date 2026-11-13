const crypto = require("node:crypto");
const { db } = require("../../database/db");
const { sendPasswordResetEmail } = require("../services/email.service");

const {
    hashPassword,
    verifyPassword,
    createSession,
    revokeSession,
    createPasswordResetToken,
    findPasswordResetToken,
    completePasswordReset,
    revokeAllUserSessions
} = require("../services/auth.service");

function validEmail(email) {
    return (
        typeof email === "string" &&
        email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    );
}

async function register(req, res) {
    try {
        const body = req.body || {};
        const { email, password } = body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required."
            });
        }

        const normalizedEmail = String(email).trim().toLowerCase();

        if (!validEmail(normalizedEmail)) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid email address."
            });
        }

        if (
            typeof password !== "string" ||
            password.length < 10 ||
            password.length > 128
        ) {
            return res.status(400).json({
                success: false,
                message: "Password must contain 10–128 characters."
            });
        }

        const existingUser = db.prepare(`
            SELECT id FROM users WHERE email = ?
        `).get(normalizedEmail);

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists."
            });
        }

        const userId = crypto.randomUUID();
        const passwordHash = await hashPassword(password);

        db.prepare(`
            INSERT INTO users (id, email, password_hash)
            VALUES (?, ?, ?)
        `).run(userId, normalizedEmail, passwordHash);

        const session = createSession(userId);

        return res.status(201).json({
            success: true,
            message: "Account created successfully.",
            user: {
                id: userId,
                email: normalizedEmail,
                role: "user"
            },
            token: session.token,
            expiresAt: session.expiresAt
        });

    } catch (error) {
        console.error("[AUTH REGISTER]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to create account."
        });
    }
}

async function login(req, res) {
    try {
        const body = req.body || {};
        const { email, password } = body;

        if (
            typeof email !== "string" ||
            typeof password !== "string" ||
            !email.trim() ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        if (!validEmail(normalizedEmail) || password.length > 128) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        const user = db.prepare(`
            SELECT id, email, password_hash, role
            FROM users
            WHERE email = ?
        `).get(normalizedEmail);

        if (!user || !(await verifyPassword(password, user.password_hash))) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        const session = createSession(user.id);

        return res.json({
            success: true,
            message: "Login successful.",
            user: {
                id: user.id,
                email: user.email,
                role: user.role
            },
            token: session.token,
            expiresAt: session.expiresAt
        });

    } catch (error) {
        console.error("[AUTH LOGIN]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to log in."
        });
    }
}

function me(req, res) {
    try {
        const user = db.prepare(`
            SELECT id, email, role, created_at, updated_at
            FROM users
            WHERE id = ?
        `).get(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "Account not found."
            });
        }

        return res.json({
            success: true,
            user
        });
    } catch (error) {
        console.error("[AUTH ME]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to retrieve account details."
        });
    }
}

function logout(req, res) {
    try {
        revokeSession(req.token);

        return res.json({
            success: true,
            message: "Logged out successfully."
        });

    } catch (error) {
        console.error("[AUTH LOGOUT]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to log out."
        });
    }
}


async function changePassword(req, res) {
    try {
        const { currentPassword, newPassword } = req.body || {};

        if (
            typeof currentPassword !== "string" ||
            typeof newPassword !== "string"
        ) {
            return res.status(400).json({
                success: false,
                message: "Current password and new password are required."
            });
        }

        if (newPassword.length < 10 || newPassword.length > 128) {
            return res.status(400).json({
                success: false,
                message: "New password must contain 10–128 characters."
            });
        }

        if (currentPassword === newPassword) {
            return res.status(400).json({
                success: false,
                message: "Your new password must be different from your current password."
            });
        }

        const user = db.prepare(
            "SELECT id, password_hash FROM users WHERE id = ?"
        ).get(req.user.id);

        const passwordVerified = user
            ? await verifyPassword(currentPassword, user.password_hash)
            : false;

        if (!user || !passwordVerified) {
            return res.status(401).json({
                success: false,
                message: "Your current password is incorrect."
            });
        }

        const passwordHash = await hashPassword(newPassword);

        db.exec("BEGIN IMMEDIATE");

        let session;

        try {
            db.prepare(`
                UPDATE users
                SET password_hash = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(passwordHash, user.id);

            revokeAllUserSessions(user.id);

            db.prepare(`
                UPDATE password_reset_tokens
                SET used_at = CURRENT_TIMESTAMP
                WHERE user_id = ?
                AND used_at IS NULL
            `).run(user.id);

            session = createSession(user.id);

            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }

        return res.json({
            success: true,
            message: "Password changed successfully. Other sessions have been signed out.",
            token: session.token,
            expiresAt: session.expiresAt
        });
    } catch (error) {
        console.error("[AUTH CHANGE PASSWORD]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to change password."
        });
    }
}

async function forgotPassword(req, res) {
    const genericMessage =
        "If an account exists with that email, password reset instructions will be sent.";

    try {
        const { email } = req.body || {};

        if (typeof email !== "string" || !validEmail(email.trim())) {
            return res.json({
                success: true,
                message: genericMessage
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const user = db.prepare(
            "SELECT id, email FROM users WHERE email = ?"
        ).get(normalizedEmail);

        if (user) {
            const reset = createPasswordResetToken(user.id);

            try {
                await sendPasswordResetEmail(user.email, reset.token);
            } catch (emailError) {
                console.error(
                    "[PASSWORD RESET EMAIL]",
                    emailError.message
                );
            }
        }

        return res.json({
            success: true,
            message: genericMessage
        });
    } catch (error) {
        console.error("[AUTH FORGOT PASSWORD]", error.message);

        return res.json({
            success: true,
            message: genericMessage
        });
    }
}

async function resetPassword(req, res) {
    try {
        const { token, newPassword } = req.body || {};

        if (
            typeof token !== "string" ||
            !/^[a-f0-9]{64}$/i.test(token)
        ) {
            return res.status(400).json({
                success: false,
                message: "This password reset link is invalid or expired."
            });
        }

        if (
            typeof newPassword !== "string" ||
            newPassword.length < 10 ||
            newPassword.length > 128
        ) {
            return res.status(400).json({
                success: false,
                message: "Password must contain 10–128 characters."
            });
        }

        const reset = findPasswordResetToken(token);

        if (!reset) {
            return res.status(400).json({
                success: false,
                message: "This password reset link is invalid or expired."
            });
        }

        const passwordHash = await hashPassword(newPassword);

        try {
            completePasswordReset(
                reset.id,
                reset.user_id,
                passwordHash
            );
        } catch {
            return res.status(400).json({
                success: false,
                message: "This password reset link is invalid or expired."
            });
        }

        return res.json({
            success: true,
            message: "Password reset successfully. Please log in with your new password."
        });
    } catch (error) {
        console.error("[AUTH RESET PASSWORD]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to reset your password."
        });
    }
}

module.exports = {
    register,
    login,
    me,
    logout,
    changePassword,
    forgotPassword,
    resetPassword
};

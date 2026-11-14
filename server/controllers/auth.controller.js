const crypto = require("node:crypto");
const { db } = require("../../database/db");
const { sendPasswordResetEmail, sendVerificationEmail } = require("../services/email.service");

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

function generateVerificationCode() {
    const code = String(crypto.randomInt(0, 100000000)).padStart(8, "0");
    const salt = crypto.randomBytes(16).toString("hex");

    const codeHash = crypto.scryptSync(code, salt, 64).toString("hex");

    return {
        code,
        salt,
        codeHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    };
}

async function issueVerificationCode(userId, email) {
    const verification = generateVerificationCode();

    db.prepare(`
        INSERT INTO email_verification_codes
            (user_id, code_hash, salt, expires_at, attempts, last_sent_at)
        VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            code_hash = excluded.code_hash,
            salt = excluded.salt,
            expires_at = excluded.expires_at,
            attempts = 0,
            last_sent_at = CURRENT_TIMESTAMP,
            created_at = CURRENT_TIMESTAMP
    `).run(
        userId,
        verification.codeHash,
        verification.salt,
        verification.expiresAt
    );

    try {
        await sendVerificationEmail(email, verification.code);
    } catch (error) {
        db.prepare(
            "DELETE FROM email_verification_codes WHERE user_id = ?"
        ).run(userId);

        throw error;
    }
}

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
            SELECT id, email_verified FROM users WHERE email = ?
        `).get(normalizedEmail);

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: existingUser.email_verified
                    ? "An account with this email already exists."
                    : "An account with this email is awaiting verification. Please request a new confirmation code."
            });
        }

        const userId = crypto.randomUUID();
        const passwordHash = await hashPassword(password);

        db.prepare(`
            INSERT INTO users (id, email, password_hash, email_verified)
            VALUES (?, ?, ?, 0)
        `).run(userId, normalizedEmail, passwordHash);

        try {
            await issueVerificationCode(userId, normalizedEmail);
        } catch (emailError) {
            console.error("[REGISTRATION VERIFICATION EMAIL]", emailError.message);

            return res.status(503).json({
                success: false,
                message: "Your account was created, but the confirmation email could not be sent. Please request a new code."
            });
        }

        return res.status(201).json({
            success: true,
            message: "Account created. A confirmation code has been sent to your email.",
            email: normalizedEmail,
            requiresVerification: true
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
            SELECT id, email, password_hash, role, email_verified
            FROM users
            WHERE email = ?
        `).get(normalizedEmail);

        if (!user || !(await verifyPassword(password, user.password_hash))) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        if (!user.email_verified) {
            return res.status(403).json({
                success: false,
                requiresVerification: true,
                message: "Please verify your email address before logging in."
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

function verifyEmail(req, res) {
    try {
        const { email, code } = req.body || {};

        if (
            typeof email !== "string" ||
            !validEmail(email.trim()) ||
            typeof code !== "string" ||
            !/^\d{8}$/.test(code)
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid email address and 8-digit confirmation code."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const user = db.prepare(`
            SELECT id, email, email_verified
            FROM users
            WHERE email = ?
        `).get(normalizedEmail);

        if (!user) {
            return res.status(400).json({
                success: false,
                message: "Invalid or expired confirmation code."
            });
        }

        if (user.email_verified) {
            return res.json({
                success: true,
                message: "Your email address is already verified. You can log in."
            });
        }

        const record = db.prepare(`
            SELECT code_hash, salt, expires_at, attempts
            FROM email_verification_codes
            WHERE user_id = ?
        `).get(user.id);

        if (!record || Date.now() > Date.parse(record.expires_at)) {
            return res.status(400).json({
                success: false,
                message: "Your confirmation code has expired. Please request a new one."
            });
        }

        if (record.attempts >= 5) {
            return res.status(429).json({
                success: false,
                message: "Too many incorrect attempts. Please request a new confirmation code."
            });
        }

        const submittedHash = crypto.scryptSync(
            code,
            record.salt,
            64
        );

        const storedHash = Buffer.from(record.code_hash, "hex");

        const matches =
            storedHash.length === submittedHash.length &&
            crypto.timingSafeEqual(submittedHash, storedHash);

        if (!matches) {
            db.prepare(`
                UPDATE email_verification_codes
                SET attempts = attempts + 1
                WHERE user_id = ?
            `).run(user.id);

            return res.status(400).json({
                success: false,
                message: record.attempts + 1 >= 5
                    ? "Too many incorrect attempts. Please request a new confirmation code."
                    : "Incorrect confirmation code."
            });
        }

        db.exec("BEGIN IMMEDIATE");

        try {
            db.prepare(`
                UPDATE users
                SET email_verified = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(user.id);

            db.prepare(
                "DELETE FROM email_verification_codes WHERE user_id = ?"
            ).run(user.id);

            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }

        return res.json({
            success: true,
            message: "Email verified successfully. You can now log in."
        });
    } catch (error) {
        console.error("[AUTH VERIFY EMAIL]", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to verify your email address."
        });
    }
}

async function resendVerificationCode(req, res) {
    try {
        const { email } = req.body || {};

        if (typeof email !== "string" || !validEmail(email.trim())) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid email address."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const user = db.prepare(`
            SELECT id, email, email_verified
            FROM users
            WHERE email = ?
        `).get(normalizedEmail);

        const genericMessage =
            "If the account exists and needs verification, a confirmation code will be sent.";

        if (!user || user.email_verified) {
            return res.json({
                success: true,
                message: genericMessage
            });
        }

        const existingCode = db.prepare(`
            SELECT last_sent_at
            FROM email_verification_codes
            WHERE user_id = ?
        `).get(user.id);

        if (existingCode) {
            const lastSent = Date.parse(existingCode.last_sent_at);

            if (
                Number.isFinite(lastSent) &&
                Date.now() - lastSent < 60 * 1000
            ) {
                return res.status(429).json({
                    success: false,
                    message: "Please wait 60 seconds between confirmation code requests."
                });
            }
        }

        await issueVerificationCode(user.id, user.email);

        return res.json({
            success: true,
            message: "A new confirmation code has been sent to your email."
        });
    } catch (error) {
        console.error("[AUTH RESEND VERIFICATION]", error.message);

        return res.status(503).json({
            success: false,
            message: "Unable to send a confirmation email. Please try again later."
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
    verifyEmail,
    resendVerificationCode,
    me,
    logout,
    changePassword,
    forgotPassword,
    resetPassword
};

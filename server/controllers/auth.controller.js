const crypto = require("node:crypto");
const { db } = require("../../database/db");

const {
    hashPassword,
    verifyPassword,
    createSession,
    revokeSession
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
    return res.json({
        success: true,
        user: req.user
    });
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

module.exports = {
    register,
    login,
    me,
    logout
};

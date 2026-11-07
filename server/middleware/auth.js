const { findSession } = require("../services/auth.service");

function authenticate(req, res, next) {
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
        return res.status(401).json({
            success: false,
            message: "Authentication required."
        });
    }

    const token = authorization.slice(7).trim();

    if (!/^[a-f0-9]{64}$/i.test(token)) {
        return res.status(401).json({
            success: false,
            message: "Invalid authentication token."
        });
    }

    try {
        const session = findSession(token);

        if (!session) {
            return res.status(401).json({
                success: false,
                message: "Session expired or invalid."
            });
        }

        req.token = token;

        req.user = {
            id: session.user_id,
            email: session.email,
            role: session.role
        };

        next();

    } catch (error) {
        console.error("[AUTH MIDDLEWARE]", error.message);

        return res.status(500).json({
            success: false,
            message: "Authentication error."
        });
    }
}

module.exports = authenticate;

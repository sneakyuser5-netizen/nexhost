const crypto = require("node:crypto");
const { db } = require("../../database/db");

const categories = [
    "technical",
    "account",
    "billing",
    "deployment",
    "other"
];

const priorities = ["low", "normal", "high", "urgent"];

function createTicket(req, res) {
    try {
        const { subject, message, category, priority } = req.body || {};

        if (
            typeof subject !== "string" ||
            typeof message !== "string" ||
            subject.trim().length < 5 ||
            subject.trim().length > 120 ||
            message.trim().length < 10 ||
            message.trim().length > 5000 ||
            !categories.includes(category) ||
            !priorities.includes(priority)
        ) {
            return res.status(400).json({
                success: false,
                message: "Please provide valid ticket details."
            });
        }

        const id = crypto.randomUUID();

        db.prepare(`
            INSERT INTO support_tickets
            (id, user_id, subject, category, priority)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, req.user.id, subject.trim(), category, priority);

        db.prepare(`
            INSERT INTO support_messages
            (id, ticket_id, sender_id, message)
            VALUES (?, ?, ?, ?)
        `).run(
            crypto.randomUUID(),
            id,
            req.user.id,
            message.trim()
        );

        return res.status(201).json({
            success: true,
            message: "Support ticket submitted successfully.",
            ticket: { id }
        });
    } catch (error) {
        console.error("[SUPPORT CREATE]", error.message);
        return res.status(500).json({
            success: false,
            message: "Unable to submit support ticket."
        });
    }
}

function listTickets(req, res) {
    try {
        const isAdmin = req.user.role === "admin";

        const tickets = isAdmin
            ? db.prepare(`
                SELECT t.*, u.email AS user_email,
                    (SELECT COUNT(*) FROM support_messages m
                     WHERE m.ticket_id = t.id) AS message_count
                FROM support_tickets t
                JOIN users u ON u.id = t.user_id
                ORDER BY t.updated_at DESC
            `).all()
            : db.prepare(`
                SELECT *,
                    (SELECT COUNT(*) FROM support_messages m
                     WHERE m.ticket_id = support_tickets.id) AS message_count
                FROM support_tickets
                WHERE user_id = ?
                ORDER BY updated_at DESC
            `).all(req.user.id);

        return res.json({ success: true, tickets });
    } catch (error) {
        console.error("[SUPPORT LIST]", error.message);
        return res.status(500).json({
            success: false,
            message: "Unable to load support tickets."
        });
    }
}

function getTicket(req, res) {
    try {
        const isAdmin = req.user.role === "admin";

        const ticket = isAdmin
            ? db.prepare(`
                SELECT t.*, u.email AS user_email
                FROM support_tickets t
                JOIN users u ON u.id = t.user_id
                WHERE t.id = ?
            `).get(req.params.id)
            : db.prepare(`
                SELECT *
                FROM support_tickets
                WHERE id = ? AND user_id = ?
            `).get(req.params.id, req.user.id);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: "Support ticket not found."
            });
        }

        const messages = db.prepare(`
            SELECT m.id, m.message, m.created_at,
                   u.email AS sender_email, u.role AS sender_role
            FROM support_messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.ticket_id = ?
            ORDER BY m.created_at ASC
        `).all(ticket.id);

        return res.json({
            success: true,
            ticket,
            messages
        });
    } catch (error) {
        console.error("[SUPPORT DETAIL]", error.message);
        return res.status(500).json({
            success: false,
            message: "Unable to load ticket."
        });
    }
}

function replyTicket(req, res) {
    try {
        const { message } = req.body || {};

        if (
            typeof message !== "string" ||
            message.trim().length < 1 ||
            message.trim().length > 5000
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter a message of up to 5000 characters."
            });
        }

        const ticket = req.user.role === "admin"
            ? db.prepare("SELECT * FROM support_tickets WHERE id = ?")
                .get(req.params.id)
            : db.prepare("SELECT * FROM support_tickets WHERE id = ? AND user_id = ?")
                .get(req.params.id, req.user.id);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: "Support ticket not found."
            });
        }

        if (ticket.status === "closed") {
            return res.status(400).json({
                success: false,
                message: "This ticket is closed."
            });
        }

        db.prepare(`
            INSERT INTO support_messages
            (id, ticket_id, sender_id, message)
            VALUES (?, ?, ?, ?)
        `).run(
            crypto.randomUUID(),
            ticket.id,
            req.user.id,
            message.trim()
        );

        const nextStatus = req.user.role === "admin"
            ? "in_progress"
            : "open";

        db.prepare(`
            UPDATE support_tickets
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(nextStatus, ticket.id);

        return res.status(201).json({
            success: true,
            message: "Reply submitted successfully."
        });
    } catch (error) {
        console.error("[SUPPORT REPLY]", error.message);
        return res.status(500).json({
            success: false,
            message: "Unable to send reply."
        });
    }
}

function updateTicketStatus(req, res) {
    try {
        if (req.user.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "Administrator access required."
            });
        }

        const { status } = req.body || {};

        if (!["open", "in_progress", "resolved", "closed"].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid ticket status."
            });
        }

        const result = db.prepare(`
            UPDATE support_tickets
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(status, req.params.id);

        if (!result.changes) {
            return res.status(404).json({
                success: false,
                message: "Support ticket not found."
            });
        }

        return res.json({
            success: true,
            message: "Ticket status updated."
        });
    } catch (error) {
        console.error("[SUPPORT STATUS]", error.message);
        return res.status(500).json({
            success: false,
            message: "Unable to update ticket status."
        });
    }
}

module.exports = {
    createTicket,
    listTickets,
    getTicket,
    replyTicket,
    updateTicketStatus
};

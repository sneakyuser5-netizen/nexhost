const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const storageDir = path.join(__dirname, "../storage");

if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
}

const databasePath = path.join(storageDir, "nexhost.sqlite");

const db = new DatabaseSync(databasePath);

// Database configuration
db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
`);

// Initialize schema
const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");


db.exec(schema);

// ROLLBACK_METADATA_MIGRATION
const rollbackMigration = db.prepare(
    "SELECT version FROM schema_migrations WHERE version = 3"
).get();

if (!rollbackMigration) {
    db.exec("BEGIN IMMEDIATE");

    try {
        const columns = db.prepare(
            "PRAGMA table_info(deployments)"
        ).all();

        if (!columns.some(column => column.name === "rollback_of")) {
            db.exec(
                "ALTER TABLE deployments ADD COLUMN rollback_of TEXT"
            );
        }

        db.prepare(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (3)"
        ).run();

        db.exec("COMMIT");
        console.log("[DATABASE] Migration 3 applied: rollback metadata.");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}


// PASSWORD_RESET_MIGRATION
const passwordResetMigration = db.prepare(
    "SELECT version FROM schema_migrations WHERE version = 4"
).get();

if (!passwordResetMigration) {
    db.exec("BEGIN IMMEDIATE");

    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at TEXT NOT NULL,
                used_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
            ON password_reset_tokens(user_id);
        `);

        db.prepare(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (4)"
        ).run();

        db.exec("COMMIT");
        console.log("[DATABASE] Migration 4 applied: password reset tokens.");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}


// SUPPORT_TICKETS_MIGRATION
const supportMigration = db.prepare(
    "SELECT version FROM schema_migrations WHERE version = 5"
).get();

if (!supportMigration) {
    db.exec("BEGIN IMMEDIATE");

    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                subject TEXT NOT NULL,
                category TEXT NOT NULL CHECK (
                    category IN ('technical', 'account', 'billing', 'deployment', 'other')
                ),
                priority TEXT NOT NULL DEFAULT 'normal' CHECK (
                    priority IN ('low', 'normal', 'high', 'urgent')
                ),
                status TEXT NOT NULL DEFAULT 'open' CHECK (
                    status IN ('open', 'in_progress', 'resolved', 'closed')
                ),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS support_messages (
                id TEXT PRIMARY KEY,
                ticket_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
                FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_support_tickets_user
            ON support_tickets(user_id);

            CREATE INDEX IF NOT EXISTS idx_support_tickets_status
            ON support_tickets(status);

            CREATE INDEX IF NOT EXISTS idx_support_messages_ticket
            ON support_messages(ticket_id);
        `);

        db.prepare(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (5)"
        ).run();

        db.exec("COMMIT");
        console.log("[DATABASE] Migration 5 applied: support tickets.");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}


// EMAIL_VERIFICATION_MIGRATION
const emailVerificationMigration = db.prepare(
    "SELECT version FROM schema_migrations WHERE version = 6"
).get();

if (!emailVerificationMigration) {
    db.exec("BEGIN IMMEDIATE");

    try {
        const userColumns = db.prepare(
            "PRAGMA table_info(users)"
        ).all();

        if (!userColumns.some(column => column.name === "email_verified")) {
            db.exec(`
                ALTER TABLE users
                ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1
                CHECK(email_verified IN (0, 1))
            `);
        }

        db.exec(`
            CREATE TABLE IF NOT EXISTS email_verification_codes (
                user_id TEXT PRIMARY KEY,
                code_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_email_verification_expiry
            ON email_verification_codes(expires_at);
        `);

        db.prepare(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (6)"
        ).run();

        db.exec("COMMIT");
        console.log("[DATABASE] Migration 6 applied: email verification.");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}


// BOT_CONFIGURATION_MIGRATION
const botConfigMigration = db.prepare(
    "SELECT version FROM schema_migrations WHERE version = 7"
).get();

if (!botConfigMigration) {
    db.exec("BEGIN IMMEDIATE");

    try {
        const botColumns = db.prepare(
            "PRAGMA table_info(bots)"
        ).all();

        if (!botColumns.some(column => column.name === "startup_args")) {
            db.exec(
                "ALTER TABLE bots ADD COLUMN startup_args TEXT NOT NULL DEFAULT '[]'"
            );
        }

        db.exec(`
            CREATE TABLE IF NOT EXISTS bot_environment_variables (
                bot_id TEXT NOT NULL,
                name TEXT NOT NULL,
                iv TEXT NOT NULL,
                auth_tag TEXT NOT NULL,
                ciphertext TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (bot_id, name),
                FOREIGN KEY(bot_id) REFERENCES bots(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_bot_environment_variables_bot
            ON bot_environment_variables(bot_id);
        `);

        db.prepare(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (7)"
        ).run();

        db.exec("COMMIT");
        console.log("[DATABASE] Migration 7 applied: bot configuration.");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

console.log("[DATABASE] SQLite initialized successfully.");

function closeDatabase() {
    db.close();
}

module.exports = {
    db,
    closeDatabase
};

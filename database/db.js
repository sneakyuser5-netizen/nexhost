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


console.log("[DATABASE] SQLite initialized successfully.");

function closeDatabase() {
    db.close();
}

module.exports = {
    db,
    closeDatabase
};

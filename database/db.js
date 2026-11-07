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

console.log("[DATABASE] SQLite initialized successfully.");

function closeDatabase() {
    db.close();
}

module.exports = {
    db,
    closeDatabase
};

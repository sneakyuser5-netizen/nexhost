const { db, closeDatabase } = require("./db");

try {
    const version = db.prepare(
        "SELECT sqlite_version() AS version"
    ).get();

    const tables = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all();

    console.log("\n━━━ NEXHOST DATABASE ━━━");

    console.log("SQLite version:", version.version);

    console.log("\nRegistered tables:");

    for (const table of tables) {
        console.log("  ✓", table.name);
    }

    console.log("\nDatabase verification successful.");

} catch (error) {
    console.error("[DATABASE ERROR]", error.message);
    process.exitCode = 1;

} finally {
    closeDatabase();
}

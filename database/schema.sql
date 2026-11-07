PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- USERS
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user'
        CHECK(role IN ('user', 'admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- BOTS
CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    runtime TEXT NOT NULL DEFAULT 'node',
    entry_file TEXT NOT NULL DEFAULT 'index.js',

    status TEXT NOT NULL DEFAULT 'stopped'
        CHECK(status IN ('stopped', 'running', 'crashed')),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(owner_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    UNIQUE(owner_id, name)
);

-- DEPLOYMENTS
CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    version INTEGER NOT NULL,

    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN (
            'queued',
            'installing',
            'starting',
            'running',
            'failed',
            'stopped'
        )),

    source_type TEXT NOT NULL DEFAULT 'upload'
        CHECK(source_type IN ('upload', 'git')),

    source_ref TEXT,

    started_at TEXT,
    finished_at TEXT,
    error_message TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(bot_id)
        REFERENCES bots(id)
        ON DELETE CASCADE,

    UNIQUE(bot_id, version)
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_bots_owner
ON bots(owner_id);

CREATE INDEX IF NOT EXISTS idx_deployments_bot
ON deployments(bot_id);

CREATE INDEX IF NOT EXISTS idx_deployments_status
ON deployments(status);

INSERT OR IGNORE INTO schema_migrations(version)
VALUES (1);

-- USER SESSIONS
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_token
ON sessions(token_hash);

INSERT OR IGNORE INTO schema_migrations(version)
VALUES (2);

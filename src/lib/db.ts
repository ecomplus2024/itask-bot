import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// In the packaged desktop app the server runs with cwd inside read-only
// install resources, so the main process points ITASK_DATA_DIR at userData.
const dataDir = path.join(process.env.ITASK_DATA_DIR || process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "itask-bot.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ai_base_url TEXT,
    ai_api_key TEXT,
    ai_model TEXT,
    ai_system_prompt TEXT
  );

  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '🤖',
    system_prompt TEXT NOT NULL DEFAULT '',
    ai_base_url TEXT,
    ai_api_key TEXT,
    ai_model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bot_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    direct_bot_id INTEGER REFERENCES bots(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'bot')),
    ref_id INTEGER NOT NULL,
    PRIMARY KEY (room_id, kind, ref_id)
  );

  CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'bot')),
    sender_id INTEGER NOT NULL,
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-user read cursor: highest message id the user has seen in each
  -- room. Unread = messages after it (minus the user's own messages).
  CREATE TABLE IF NOT EXISTS room_reads (
    user_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, room_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_user ON mcp_servers(user_id);
  CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_bot ON bot_memories(bot_id);
  CREATE INDEX IF NOT EXISTS idx_rooms_user ON rooms(user_id);
  CREATE TABLE IF NOT EXISTS bot_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bot_doc_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES bot_documents(id) ON DELETE CASCADE,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bot_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    instruction TEXT NOT NULL,
    interval_minutes INTEGER,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id INTEGER REFERENCES bots(id) ON DELETE SET NULL,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    content BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_room_msgs ON room_messages(room_id);
  CREATE INDEX IF NOT EXISTS idx_docs_bot ON bot_documents(bot_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_bot ON bot_doc_chunks(bot_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON bot_tasks(enabled, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
`);

// Migrate: attach skills / mcp_servers to a specific bot (NULL = shared for all bots)
for (const [table, col] of [
  ["skills", "bot_id"],
  ["mcp_servers", "bot_id"],
  ["rooms", "direct_bot_id"],
] as const) {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${col} INTEGER REFERENCES bots(id) ON DELETE CASCADE`
    );
  }
}

// Migrate: persistent compaction state on rooms
for (const [col, ddl] of [
  ["summary", "TEXT NOT NULL DEFAULT ''"],
  ["summary_before_id", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  const cols = db.pragma("table_info(rooms)") as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE rooms ADD COLUMN ${col} ${ddl}`);
  }
}

// Migrate: proactive "heartbeat" settings on bots — how often a bot wakes
// up on its own to review its work and act unprompted.
for (const [col, ddl] of [
  ["proactive_minutes", "INTEGER NOT NULL DEFAULT 0"],
  ["last_proactive_at", "TEXT"],
  ["last_consolidated_at", "TEXT"],
] as const) {
  const cols = db.pragma("table_info(bots)") as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE bots ADD COLUMN ${col} ${ddl}`);
  }
}

// Migrate: cron-based schedules on bot_tasks — a cron expression + IANA
// timezone complements the existing one-shot/interval model.
for (const [col, ddl] of [
  ["cron_expr", "TEXT"],
  ["timezone", "TEXT"],
] as const) {
  const cols = db.pragma("table_info(bot_tasks)") as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE bot_tasks ADD COLUMN ${col} ${ddl}`);
  }
}

// Migrate: Deepgram API key for the voice-chat feature (per-user, env fallback).
{
  const cols = db.pragma("table_info(user_settings)") as { name: string }[];
  if (!cols.some((c) => c.name === "deepgram_api_key")) {
    db.exec(`ALTER TABLE user_settings ADD COLUMN deepgram_api_key TEXT`);
  }
  if (!cols.some((c) => c.name === "gemini_api_key")) {
    db.exec(`ALTER TABLE user_settings ADD COLUMN gemini_api_key TEXT`);
  }
  if (!cols.some((c) => c.name === "jev_api_key")) {
    db.exec(`ALTER TABLE user_settings ADD COLUMN jev_api_key TEXT`);
  }
  if (!cols.some((c) => c.name === "voice_language")) {
    db.exec(`ALTER TABLE user_settings ADD COLUMN voice_language TEXT`);
  }
  if (!cols.some((c) => c.name === "voice_name")) {
    db.exec(`ALTER TABLE user_settings ADD COLUMN voice_name TEXT`);
  }
  if (!cols.some((c) => c.name === "live_voice_name")) {
    db.exec(`ALTER TABLE user_settings ADD COLUMN live_voice_name TEXT`);
  }
}

// Migrate: rooms.kind — 'bot_dm' marks private bot↔bot channels created by
// itask__ask_bot. Regular user rooms are 'normal'.
{
  const cols = db.pragma("table_info(rooms)") as { name: string }[];
  if (!cols.some((c) => c.name === "kind")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'`);
  }
}

// Migrate: structured memory — 'core' facts (always loaded), 'note' topic
// notes (loaded when relevant). 'log' activity entries are retired:
// conversation history already lives in room_messages and bots recall it
// via itask__search_history — memory is for distilled lessons only.
{
  const cols = db.pragma("table_info(bot_memories)") as { name: string }[];
  if (!cols.some((c) => c.name === "kind")) {
    db.exec(
      `ALTER TABLE bot_memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'core'`
    );
    db.exec(`ALTER TABLE bot_memories ADD COLUMN topic TEXT`);
  }
  db.exec("DELETE FROM bot_memories WHERE kind = 'log'");
}

// Skills and MCP servers are shared across all bots — normalize legacy
// per-bot assignments to shared (bot_id = NULL).
db.exec("UPDATE skills SET bot_id = NULL WHERE bot_id IS NOT NULL");
db.exec("UPDATE mcp_servers SET bot_id = NULL WHERE bot_id IS NOT NULL");

// FTS index for knowledge chunks (rebuilt automatically on insert/delete in knowledge.ts)
try {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS bot_chunks_fts USING fts5(content, content='bot_doc_chunks', content_rowid='id')`
  );
} catch {
  // FTS5 unavailable — keyword fallback will be used
}

export default db;

// Kick off background services (scheduler + realtime socket) the first time
// the DB is touched in a server process. instrumentation.ts does this too in
// dev, but it is not bundled into the standalone build — and both services
// are guarded by globalThis flags so double-start is a no-op.
if (typeof window === "undefined") {
  setTimeout(() => {
    void import("./scheduler").then((m) => m.startScheduler()).catch(() => {});
    void import("./ws-server").then((m) => m.startWsServer()).catch(() => {});
  }, 0);
}

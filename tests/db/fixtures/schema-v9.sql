-- SCHEMA_SQL as v9 first landed (commit 9f18d76): no plan_files.archived_at, no app_opens.
-- What an old database looks like, so it never changes.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  last_indexed_at INTEGER,
  last_modified INTEGER,
  tool TEXT NOT NULL DEFAULT 'claude',
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  file_mtime_ms INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  -- Append-only indexing state: bytes consumed so far, plus fingerprints of the
  -- file's first bytes and of the bytes just before the offset. A file that still
  -- matches both has only grown, so only the new bytes are parsed.
  size_bytes INTEGER NOT NULL DEFAULT 0,
  indexed_bytes INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT,
  tail_hash TEXT,
  -- Set when the source file disappeared (e.g. Claude Code's transcript cleanup)
  -- and the archive setting kept the rows.
  archived_at INTEGER,
  UNIQUE(project_id, rel_path)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  content_kinds TEXT,
  raw_preview TEXT,
  message_class TEXT NOT NULL DEFAULT 'dialog',
  ts_ms INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_creation_1h_tokens INTEGER,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  cwd TEXT,
  git_branch TEXT,
  -- Stable identity: the line uuid, or file#line when the line has none.
  msg_key TEXT NOT NULL,
  -- API response identity; usage repeats on every line of one response.
  api_msg_id TEXT,
  request_id TEXT,
  is_prompt INTEGER NOT NULL DEFAULT 0,
  prompt_text TEXT,
  UNIQUE(session_id, line_index)
);

-- Bookkeeping lines (70% of rows on a real corpus) are stored for the transcript
-- view but kept out of the full-text index.
CREATE VIEW IF NOT EXISTS messages_searchable AS
  SELECT id, body FROM messages WHERE message_class != 'meta';

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  content='messages_searchable',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
WHEN new.message_class != 'meta' BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages
WHEN old.message_class != 'meta' BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.id, old.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_au_old AFTER UPDATE ON messages
WHEN old.message_class != 'meta' BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.id, old.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_au_new AFTER UPDATE ON messages
WHEN new.message_class != 'meta' BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TABLE IF NOT EXISTS plan_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL UNIQUE,
  file_mtime_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS plan_files_fts USING fts5(
  title,
  body,
  content='plan_files',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS plan_files_ai AFTER INSERT ON plan_files BEGIN
  INSERT INTO plan_files_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS plan_files_ad AFTER DELETE ON plan_files BEGIN
  INSERT INTO plan_files_fts(plan_files_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS plan_files_au AFTER UPDATE ON plan_files BEGIN
  INSERT INTO plan_files_fts(plan_files_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
  INSERT INTO plan_files_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- A favorite keeps a snapshot of what was starred, so it survives even when the
-- source line is gone (file deleted, archive mode off).
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  role TEXT NOT NULL,
  project_label TEXT NOT NULL DEFAULT '',
  session_file TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS message_tags (
  msg_key TEXT NOT NULL,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (msg_key, tag_id)
);

-- Reverse index: which messages touched which file. Lets the app answer
-- "when did I last work on App.tsx, and why" without scanning bodies.
CREATE TABLE IF NOT EXISTS file_refs (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  basename TEXT NOT NULL,
  PRIMARY KEY (message_id, path)
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- User-editable price list, in USD per million tokens. Deliberately NOT tied
-- to SCHEMA_VERSION: it holds no parsed data, so adding it needs no reindex.
-- Seeded from dated defaults but always user-overridable — published prices
-- change, and a stale hardcoded number is worse than an editable one.
CREATE TABLE IF NOT EXISTS model_prices (
  model TEXT PRIMARY KEY,
  input_per_mtok REAL NOT NULL,
  output_per_mtok REAL NOT NULL,
  cache_read_per_mtok REAL NOT NULL,
  cache_write_per_mtok REAL NOT NULL,
  cache_write_1h_per_mtok REAL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_refs_path ON file_refs(path);
CREATE INDEX IF NOT EXISTS idx_file_refs_basename ON file_refs(basename);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_key ON messages(msg_key);
-- Covering indexes for stats: per-response usage and role counts are read from these
-- instead of scanning ~700k wide message rows.
CREATE INDEX IF NOT EXISTS idx_messages_usage_cover ON messages(
  api_msg_id, request_id, model, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens
) WHERE input_tokens IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_class_role ON messages(message_class, role);
CREATE INDEX IF NOT EXISTS idx_messages_prompt ON messages(ts_ms) WHERE is_prompt = 1;
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_message_tags_tag ON message_tags(tag_id);

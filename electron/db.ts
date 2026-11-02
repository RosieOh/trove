import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { readLines } from './lineReader.js'

export type DbHandle = Database.Database

export const SCHEMA_VERSION = 10

/** The file was written by a newer build. This build cannot know what a write would break. */
export class NewerSchemaError extends Error {
  constructor(readonly version: number) {
    super(`database is schema v${version}; this build knows up to v${SCHEMA_VERSION}`)
  }
}

/**
 * Opens the vault DB. Only the main process migrates (`migrate: true`, before the
 * index worker starts); the worker opens the already-migrated file.
 */
export function openVaultDb(dbFile: string, opts: { migrate?: boolean; busyTimeoutMs?: number } = {}): DbHandle {
  const dir = path.dirname(dbFile)
  fs.mkdirSync(dir, { recursive: true })
  // Two connections share this file (main for queries/user writes, the index worker
  // for bulk writes). Wait for the other's short write transactions instead of failing.
  const db = new Database(dbFile, { timeout: opts.busyTimeoutMs ?? 10_000 })
  try {
    db.pragma('journal_mode = WAL')
    // WAL + NORMAL never corrupts; at worst the last transactions before a power loss
    // are lost, and the index rebuilds them from ~/.claude on the next scan.
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    if (opts.migrate !== false) migrate(db)
    return db
  } catch (err) {
    // A corrupt file only surfaces once a statement runs. Close the handle so
    // the caller can quarantine the file — on Windows an open handle locks it
    // and the rename would fail with EBUSY.
    try {
      db.close()
    } catch {
      /* handle may already be unusable */
    }
    throw err
  }
}

/**
 * Tables split into two kinds:
 * - **Index** (projects, sessions, messages, file_refs, plan_files + FTS): derived from
 *   files under ~/.claude, rebuildable — except sessions archived after their source
 *   file was deleted (see `archived_at`), which only exist here.
 * - **User data** (favorites, tags, message_tags, templates, model_prices, app_opens,
 *   settings in `meta`): never derivable. Favorites and tags key on `messages.msg_key` (the line's
 *   stable `uuid`), not on row ids, so re-indexing a session can never drop them.
 */
const SCHEMA_SQL = `
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
    body TEXT NOT NULL,
    -- Set when the source file was deleted and archive mode is Keep (like sessions).
    archived_at INTEGER
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

  -- Local days (YYYY-MM-DD) the app was opened or focused: the dogfooding measure in
  -- docs/roadmap.md. Dates only, never sent anywhere. User data, so no reindex needed.
  CREATE TABLE IF NOT EXISTS app_opens (
    day TEXT PRIMARY KEY
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
`

function tableExists(db: DbHandle, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name))
}

function columns(db: DbHandle, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
}

export function readSchemaVersion(db: DbHandle): number {
  if (!tableExists(db, 'meta')) return 0
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
  return row ? Number(row.value) : 0
}

function migrate(db: DbHandle) {
  const v = readSchemaVersion(db)
  if (v > SCHEMA_VERSION) throw new NewerSchemaError(v)
  if (v > 0 && v < 9) migrateLegacyToV9(db)
  else if (v === 0 && tableExists(db, 'messages')) migrateLegacyToV9(db)
  // Superseded by the covering idx_messages_usage_cover (early v9 builds created it).
  db.exec(`DROP INDEX IF EXISTS idx_messages_usage`)
  db.exec(SCHEMA_SQL)
  // v9 → v10: plans follow archive mode. Adding a nullable column needs no re-parse.
  if (!columns(db, 'plan_files').has('archived_at')) db.exec(`ALTER TABLE plan_files ADD COLUMN archived_at INTEGER`)
  // From v9 on, a migration must never drop sessions/messages wholesale: archived
  // sessions exist only in this DB. Re-parse live files by resetting
  // `sessions.indexed_bytes` instead (see `requestFullReparse`).
  if (v < SCHEMA_VERSION) {
    db.prepare(
      `INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(SCHEMA_VERSION))
  }
}

/** Forces every live (non-archived) session to be parsed from byte 0 on the next scan. */
export function requestFullReparse(db: DbHandle): void {
  db.prepare(`UPDATE sessions SET indexed_bytes = 0, head_hash = NULL, tail_hash = NULL WHERE archived_at IS NULL`).run()
}

type LegacyRef = { filePath: string; lineIndex: number }

/**
 * The legacy indexer numbered every non-blank line from 0. Re-read just the lines
 * that user data points at and return their stable key (line `uuid`, Codex
 * `payload.id`), falling back to `file#line` when the file or the uuid is gone.
 */
export function resolveLegacyKeys(refs: LegacyRef[]): Map<string, string> {
  const out = new Map<string, string>()
  const byFile = new Map<string, Set<number>>()
  for (const r of refs) {
    const set = byFile.get(r.filePath) ?? new Set<number>()
    set.add(r.lineIndex)
    byFile.set(r.filePath, set)
  }
  for (const [filePath, wanted] of byFile) {
    const found = new Map<number, string>()
    try {
      if (fs.existsSync(filePath)) {
        let idx = 0
        const max = Math.max(...wanted)
        for (const { text: line } of readLines(filePath)) {
          if (!line.trim()) continue
          if (wanted.has(idx)) {
            try {
              const obj = JSON.parse(line) as { uuid?: unknown; payload?: { id?: unknown } }
              const key = typeof obj.uuid === 'string' ? obj.uuid : typeof obj.payload?.id === 'string' ? obj.payload.id : ''
              if (key) found.set(idx, key)
            } catch {
              /* unparsable line keeps the positional key */
            }
          }
          idx += 1
          if (idx > max) break
        }
      }
    } catch {
      /* unreadable file keeps positional keys */
    }
    for (const li of wanted) out.set(`${filePath}#${li}`, found.get(li) ?? `${filePath}#${li}`)
  }
  return out
}

/**
 * v≤8 → v9. Old favorites/tags referenced `messages.id` with ON DELETE CASCADE, so
 * every re-index silently deleted them. Carry them over to stable keys first, then
 * rebuild the derived index tables (the next scan repopulates them).
 */
function migrateLegacyToV9(db: DbHandle) {
  type FavRow = LegacyRef & { createdAt: number; body: string; role: string; project: string; relPath: string }
  type TagRow = LegacyRef & { tagId: number }
  let favs: FavRow[] = []
  let tagRefs: TagRow[] = []
  const hasLegacyFavs = tableExists(db, 'favorites') && columns(db, 'favorites').has('message_id')
  if (hasLegacyFavs && tableExists(db, 'messages')) {
    favs = db
      .prepare(
        `SELECT s.file_path AS filePath, m.line_index AS lineIndex, f.created_at AS createdAt,
                m.body, m.role, p.display_name AS project, s.rel_path AS relPath
         FROM favorites f
         JOIN messages m ON m.id = f.message_id
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id`,
      )
      .all() as FavRow[]
  }
  const hasLegacyTags = tableExists(db, 'message_tags') && columns(db, 'message_tags').has('message_id')
  if (hasLegacyTags && tableExists(db, 'messages')) {
    tagRefs = db
      .prepare(
        `SELECT s.file_path AS filePath, m.line_index AS lineIndex, mt.tag_id AS tagId
         FROM message_tags mt
         JOIN messages m ON m.id = mt.message_id
         JOIN sessions s ON s.id = m.session_id`,
      )
      .all() as TagRow[]
  }
  const keys = resolveLegacyKeys([...favs, ...tagRefs])
  const keyOf = (r: LegacyRef) => keys.get(`${r.filePath}#${r.lineIndex}`) ?? `${r.filePath}#${r.lineIndex}`

  db.transaction(() => {
    for (const t of ['messages_ai', 'messages_ad', 'messages_au']) db.exec(`DROP TRIGGER IF EXISTS ${t}`)
    db.exec(`DROP TABLE IF EXISTS messages_fts`)
    db.exec(`DROP VIEW IF EXISTS messages_searchable`)
    db.exec(`DROP TABLE IF EXISTS file_refs`)
    if (hasLegacyFavs) db.exec(`DROP TABLE favorites`)
    if (hasLegacyTags) db.exec(`DROP TABLE message_tags`)
    db.exec(`DROP TABLE IF EXISTS messages`)
    db.exec(`DROP TABLE IF EXISTS sessions`)
    if (tableExists(db, 'projects')) {
      const pc = columns(db, 'projects')
      if (!pc.has('tool')) db.exec(`ALTER TABLE projects ADD COLUMN tool TEXT NOT NULL DEFAULT 'claude'`)
      if (!pc.has('archived_at')) db.exec(`ALTER TABLE projects ADD COLUMN archived_at INTEGER`)
    }
    if (tableExists(db, 'model_prices') && !columns(db, 'model_prices').has('cache_write_1h_per_mtok')) {
      db.exec(`ALTER TABLE model_prices ADD COLUMN cache_write_1h_per_mtok REAL`)
      db.exec(`UPDATE model_prices SET cache_write_1h_per_mtok = input_per_mtok * 2`)
    }
    db.exec(SCHEMA_SQL)
    const insFav = db.prepare(
      `INSERT OR IGNORE INTO favorites (msg_key, created_at, body, role, project_label, session_file)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const f of favs) insFav.run(keyOf(f), f.createdAt, f.body, f.role, f.project, f.relPath)
    const insTag = db.prepare(`INSERT OR IGNORE INTO message_tags (msg_key, tag_id) VALUES (?, ?)`)
    for (const t of tagRefs) insTag.run(keyOf(t), t.tagId)
  })()
}

/** Settings live in `meta` under `setting.*` so the main process can read them before any window exists. */
export function getSetting(db: DbHandle, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`setting.${key}`) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(db: DbHandle, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(`setting.${key}`, value)
}

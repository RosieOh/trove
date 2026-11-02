import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { listBackups, openVaultDbWithRecovery, snapshot, verifyBackup } from '../../electron/backup'
import {
  BASELINE_VERSION,
  checkMigrations,
  MIGRATIONS,
  NewerSchemaError,
  openVaultDb,
  pendingMigrations,
  readSchemaVersion,
  SCHEMA_VERSION,
  tableExists,
  type DbHandle,
  type Migration,
} from '../../electron/db'
import { indexSessionFile, reconcileMissing } from '../../electron/indexer'
import * as schemaMigrations from '../../electron/migrations/0011-schema-migrations'
import { listFavorites } from '../../electron/queries'
import { listPrices } from '../../electron/prices'
import { assistantLine, createShippedDb, markStepPending, sandbox, userLine, writeLines } from './helpers'

/** The v8 schema as shipped: user data referenced messages.id with ON DELETE CASCADE. */
function createLegacyDb(dbFile: string, sessionFile: string, projectRoot: string) {
  const db = new Database(dbFile)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '8');
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL,
      display_name TEXT NOT NULL, last_indexed_at INTEGER, last_modified INTEGER, tool TEXT NOT NULL DEFAULT 'claude');
    CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, file_mtime_ms INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_id, rel_path));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      line_index INTEGER NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, content_kinds TEXT, raw_preview TEXT,
      message_class TEXT NOT NULL DEFAULT 'dialog', ts_ms INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER, is_sidechain INTEGER NOT NULL DEFAULT 0, cwd TEXT, git_branch TEXT,
      UNIQUE(session_id, line_index));
    CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='id');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body); END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.id, old.body); END;
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.id, old.body);
      INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
    END;
    CREATE TABLE plan_files (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL UNIQUE, file_mtime_ms INTEGER NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL);
    CREATE VIRTUAL TABLE plan_files_fts USING fts5(title, body, content='plan_files', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER plan_files_ai AFTER INSERT ON plan_files BEGIN INSERT INTO plan_files_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
    CREATE TRIGGER plan_files_ad AFTER DELETE ON plan_files BEGIN INSERT INTO plan_files_fts(plan_files_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body); END;
    CREATE TRIGGER plan_files_au AFTER UPDATE ON plan_files BEGIN
      INSERT INTO plan_files_fts(plan_files_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
      INSERT INTO plan_files_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    CREATE TABLE favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL);
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT);
    CREATE TABLE message_tags (message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (message_id, tag_id));
    CREATE TABLE file_refs (message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, path TEXT NOT NULL,
      basename TEXT NOT NULL, PRIMARY KEY (message_id, path));
    CREATE TABLE templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE model_prices (model TEXT PRIMARY KEY, input_per_mtok REAL NOT NULL, output_per_mtok REAL NOT NULL,
      cache_read_per_mtok REAL NOT NULL, cache_write_per_mtok REAL NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX idx_file_refs_path ON file_refs(path);
    CREATE INDEX idx_file_refs_basename ON file_refs(basename);
    CREATE INDEX idx_messages_session ON messages(session_id);
    CREATE INDEX idx_sessions_project ON sessions(project_id);
  `)
  db.prepare(`INSERT INTO projects (slug, root_path, display_name) VALUES ('-work-app', ?, '/work/app')`).run(projectRoot)
  db.prepare(`INSERT INTO sessions (project_id, rel_path, file_path, file_mtime_ms, message_count) VALUES (1, 's.jsonl', ?, 1, 2)`).run(
    sessionFile,
  )
  const ins = db.prepare(`INSERT INTO messages (session_id, line_index, role, body) VALUES (1, ?, ?, ?)`)
  ins.run(0, 'user', 'starred prompt')
  ins.run(1, 'assistant', 'tagged answer')
  db.prepare(`INSERT INTO favorites (message_id, created_at) VALUES (1, 1234)`).run()
  db.prepare(`INSERT INTO tags (name) VALUES ('keep')`).run()
  db.prepare(`INSERT INTO message_tags (message_id, tag_id) VALUES (2, 1)`).run()
  db.prepare(`INSERT INTO templates (name, body, created_at, updated_at) VALUES ('t', 'b', 1, 1)`).run()
  // A user-edited price from the old seed, plus no row for newer models.
  db.prepare(`INSERT INTO model_prices VALUES ('claude-opus-4-8', 7, 25, 0.5, 6.25, 1)`).run()
  db.close()
}

/** A live session, an archived one whose file is gone, and data hanging off each. */
function seedShipped(db: DbHandle, projectRoot: string) {
  db.prepare(`INSERT INTO projects (slug, root_path, display_name) VALUES ('-work-app', ?, '/work/app')`).run(projectRoot)
  const session = db.prepare(
    `INSERT INTO sessions (project_id, rel_path, file_path, file_mtime_ms, message_count, size_bytes, indexed_bytes, head_hash, tail_hash, archived_at)
     VALUES (1, ?, ?, 1, 2, 10, 10, 'h', 't', ?)`,
  )
  session.run('live.jsonl', path.join(projectRoot, 'live.jsonl'), null)
  session.run('gone.jsonl', path.join(projectRoot, 'gone.jsonl'), 1234)
  const msg = db.prepare(
    `INSERT INTO messages (session_id, line_index, role, body, message_class, msg_key, is_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  msg.run(1, 0, 'user', 'livequokka prompt', 'dialog', 'u-live', 1)
  msg.run(1, 1, 'assistant', 'livequokka answer', 'dialog', 'a-live', 0)
  msg.run(2, 0, 'user', 'archivedquokka prompt', 'dialog', 'u-gone', 1)
  msg.run(2, 1, 'assistant', 'bookkeeping', 'meta', 'a-gone', 0)
  db.prepare(`INSERT INTO file_refs (message_id, path, basename) VALUES (3, '/work/app/a.ts', 'a.ts')`).run()
  db.prepare(`INSERT INTO plan_files (file_path, file_mtime_ms, title, body) VALUES ('/plans/p.md', 1, 'Plan', 'planquokka')`).run()
  db.prepare(`INSERT INTO favorites (msg_key, created_at, body, role) VALUES ('u-gone', 1, 'archivedquokka prompt', 'user')`).run()
  db.prepare(`INSERT INTO tags (name) VALUES ('keep')`).run()
  db.prepare(`INSERT INTO message_tags (msg_key, tag_id) VALUES ('a-live', 1)`).run()
  db.prepare(`INSERT INTO templates (name, body, created_at, updated_at) VALUES ('t', 'b', 1, 1)`).run()
  db.prepare(`INSERT INTO meta VALUES ('setting.archiveMode', 'keep')`).run()
}

/** Every row a migration must leave alone, with the row ids user-visible state depends on. */
const rowsOf = (db: DbHandle) => ({
  messages: db.prepare(`SELECT id, session_id, line_index, role, body, message_class, msg_key, is_prompt FROM messages ORDER BY id`).all(),
  sessions: db.prepare(`SELECT id, project_id, file_path, indexed_bytes, head_hash, archived_at FROM sessions ORDER BY id`).all(),
  plans: db.prepare(`SELECT id, file_path, title, body FROM plan_files ORDER BY id`).all(),
  fileRefs: db.prepare(`SELECT message_id, path FROM file_refs ORDER BY message_id, path`).all(),
  favorites: db.prepare(`SELECT msg_key, body FROM favorites ORDER BY msg_key`).all(),
  tags: db.prepare(`SELECT msg_key, tag_id FROM message_tags ORDER BY msg_key`).all(),
  templates: db.prepare(`SELECT name, body FROM templates ORDER BY name`).all(),
  archiveMode: db.prepare(`SELECT value FROM meta WHERE key = 'setting.archiveMode'`).get(),
})

/** Object names and column names, leaving FTS shadow tables out. */
function shapeOf(db: DbHandle) {
  const objects = db
    .prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY type, name`)
    .all() as { type: string; name: string }[]
  const columns = objects
    .filter((o) => o.type === 'table')
    .map((t) => [t.name, (db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name).sort()])
  return { objects, columns: Object.fromEntries(columns) as Record<string, string[]> }
}

const hits = (db: DbHandle, word: string) =>
  (db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid`).all(word) as { rowid: number }[]).map((r) => r.rowid)

const appliedIds = (db: DbHandle) =>
  (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: number }[]).map((r) => r.id)

function expectHealthy(db: DbHandle) {
  expect(db.pragma('foreign_key_check')).toEqual([])
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  // Throws when the FTS index and the rows it covers disagree.
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
}

const readOnly = (file: string) => new Database(file, { readonly: true, fileMustExist: true })

/** Runs a build made of `migrations` against the file, as one launch of that build would. */
function launch(dbFile: string, migrations: Migration[]) {
  openVaultDb(dbFile, { migrations }).close()
}

function shippedSandbox(version: 9 | 10) {
  const sb = sandbox()
  const db = createShippedDb(sb.dbFile, version)
  seedShipped(db, sb.projectRoot)
  const rows = rowsOf(db)
  db.close()
  return { ...sb, rows }
}

/** A step that makes one table and says it ran. */
const step = (id: number, table: string, calls: number[] = []): Migration => ({
  id,
  up(db) {
    calls.push(id)
    db.exec(`CREATE TABLE ${table} (session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE)`)
  },
})

describe('migration from the v8 schema', () => {
  it('moves favorites and tags to stable keys, and re-indexing reconnects them', async () => {
    const sb = sandbox()
    const file = path.join(sb.projectRoot, 's.jsonl')
    writeLines(file, [userLine('uuid-user', 'starred prompt'), assistantLine('uuid-asst', 'tagged answer')])
    createLegacyDb(sb.dbFile, file, sb.projectRoot)

    const db = sb.open()
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)

    const fav = db.prepare(`SELECT msg_key, body, role, created_at FROM favorites`).all()
    expect(fav).toEqual([{ msg_key: 'uuid-user', body: 'starred prompt', role: 'user', created_at: 1234 }])
    expect(db.prepare(`SELECT msg_key, tag_id FROM message_tags`).all()).toEqual([{ msg_key: 'uuid-asst', tag_id: 1 }])
    expect(db.prepare(`SELECT COUNT(*) AS c FROM templates`).get()).toEqual({ c: 1 })

    // Re-indexing reconnects the favorite to the live line.
    const pid = (db.prepare(`SELECT id FROM projects`).get() as { id: number }).id
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    const [live] = listFavorites(db)
    expect(live.messageId).not.toBeNull()
    expect(live.archived).toBe(false)
  })

  it('keeps every message through the upgrade, and the next scan re-reads or archives them', async () => {
    const sb = sandbox()
    const file = path.join(sb.projectRoot, 's.jsonl')
    const gone = path.join(sb.projectRoot, 'gone.jsonl')
    writeLines(file, [userLine('uuid-user', 'starred prompt'), assistantLine('uuid-asst', 'tagged answer')])
    createLegacyDb(sb.dbFile, file, sb.projectRoot)
    const old = new Database(sb.dbFile)
    old.prepare(`INSERT INTO sessions (project_id, rel_path, file_path, file_mtime_ms, message_count) VALUES (1, 'gone.jsonl', ?, 1, 2)`).run(gone)
    const ins = old.prepare(`INSERT INTO messages (session_id, line_index, role, body, message_class) VALUES (2, ?, ?, ?, ?)`)
    ins.run(0, 'user', 'onlycopy prompt', 'dialog')
    ins.run(1, 'assistant', 'onlycopy bookkeeping', 'meta')
    old.prepare(`INSERT INTO file_refs (message_id, path, basename) VALUES (3, '/work/app/a.ts', 'a.ts')`).run()
    old.prepare(`INSERT INTO plan_files (file_path, file_mtime_ms, title, body) VALUES ('/plans/p.md', 1, 'Plan', 'planquokka')`).run()
    const lines = `SELECT id, session_id, line_index, role, body, message_class FROM messages ORDER BY id`
    const before = old.prepare(lines).all()
    old.close()

    const db = sb.open()
    expect(db.prepare(lines).all()).toEqual(before)
    expect(hits(db, 'onlycopy')).toEqual([3])
    expect(hits(db, 'tagged')).toEqual([2])
    expect(db.prepare(`SELECT msg_key FROM messages WHERE id = 3`).get()).toEqual({ msg_key: `${gone}#0` })
    expect(db.prepare(`SELECT message_id, path FROM file_refs`).all()).toEqual([{ message_id: 3, path: '/work/app/a.ts' }])
    expect(db.prepare(`SELECT title, archived_at FROM plan_files`).all()).toEqual([{ title: 'Plan', archived_at: null }])
    expectHealthy(db)

    await indexSessionFile(db, { projectId: 1, projectRoot: sb.projectRoot, filePath: file })
    reconcileMissing(db, sb.adapter, 'keep')

    const sessions = db.prepare(`SELECT file_path AS file, archived_at IS NOT NULL AS archived FROM sessions ORDER BY id`).all()
    expect(sessions).toEqual([
      { file, archived: 0 },
      { file: gone, archived: 1 },
    ])
    const keys = db.prepare(`SELECT msg_key FROM messages WHERE session_id = 1 ORDER BY line_index`).all()
    expect(keys).toEqual([{ msg_key: 'uuid-user' }, { msg_key: 'uuid-asst' }])
    expect(hits(db, 'onlycopy')).toEqual([3])
    expect(hits(db, 'starred')).toHaveLength(1)
    expectHealthy(db)
  })

  it('ends with the same tables, columns, indexes and triggers as a new DB', () => {
    const sb = sandbox()
    createLegacyDb(sb.dbFile, path.join(sb.projectRoot, 's.jsonl'), sb.projectRoot)
    const upgraded = sb.open()
    const fresh = openVaultDb(path.join(sb.dir, 'fresh.db'))
    expect(shapeOf(upgraded)).toEqual(shapeOf(fresh))
    fresh.close()
  })

  it('carries the oldest shape over too: v3, before any of the later columns', () => {
    const sb = sandbox()
    const old = new Database(sb.dbFile)
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '3');
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL,
        display_name TEXT NOT NULL, last_indexed_at INTEGER, last_modified INTEGER);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, file_mtime_ms INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, rel_path));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        line_index INTEGER NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, content_kinds TEXT, raw_preview TEXT,
        UNIQUE(session_id, line_index));
      INSERT INTO projects (slug, root_path, display_name) VALUES ('-work-app', '/work/app', '/work/app');
      INSERT INTO sessions (project_id, rel_path, file_path, file_mtime_ms) VALUES (1, 's.jsonl', '/work/app/s.jsonl', 1);
      INSERT INTO messages (session_id, line_index, role, body) VALUES (1, 0, 'user', 'oldestquokka');
    `)
    old.close()

    const db = sb.open()
    expect(db.prepare(`SELECT id, body, message_class, msg_key FROM messages`).all()).toEqual([
      { id: 1, body: 'oldestquokka', message_class: 'dialog', msg_key: '/work/app/s.jsonl#0' },
    ])
    expect(hits(db, 'oldestquokka')).toEqual([1])
    const fresh = openVaultDb(path.join(sb.dir, 'fresh.db'))
    expect(shapeOf(db)).toEqual(shapeOf(fresh))
    fresh.close()
    expectHealthy(db)
  })

  it('keeps user price edits and adds newly published models', () => {
    const sb = sandbox()
    const file = path.join(sb.projectRoot, 's.jsonl')
    writeLines(file, [userLine('u', 'x')])
    createLegacyDb(sb.dbFile, file, sb.projectRoot)
    const db = sb.open()
    const prices = listPrices(db)
    const edited = prices.find((p) => p.model === 'claude-opus-4-8')!
    expect(edited.inputPerMTok).toBe(7)
    expect(edited.cacheWrite1hPerMTok).toBe(14)
    expect(prices.some((p) => p.model === 'claude-opus-5-5')).toBe(true)
    // Seed v3 added the OpenAI models Codex sessions use, without touching the edit above.
    expect(prices.find((p) => p.model === 'gpt-5.6-sol')?.inputPerMTok).toBe(4)
  })

  it('falls back to file#line keys when the source line is gone, and the favorite still finds its row', () => {
    const sb = sandbox()
    const file = path.join(sb.projectRoot, 'gone.jsonl')
    createLegacyDb(sb.dbFile, file, sb.projectRoot)
    const db = sb.open()
    const fav = db.prepare(`SELECT msg_key, body FROM favorites`).get()
    expect(fav).toEqual({ msg_key: `${file}#0`, body: 'starred prompt' })
    expect(listFavorites(db)[0].messageId).toBe(1)
  })

  it('rolls the whole step back when it fails, so the retry starts from the v8 file', () => {
    const sb = sandbox()
    const file = path.join(sb.projectRoot, 's.jsonl')
    createLegacyDb(sb.dbFile, file, sb.projectRoot)
    const old = new Database(sb.dbFile)
    // Fails the step's last statement, once everything else in it has been done.
    old.exec(`CREATE TRIGGER fail_v9 AFTER UPDATE ON meta WHEN new.value = '9' BEGIN SELECT RAISE(ABORT, 'simulated'); END;`)
    old.close()

    expect(() => openVaultDb(sb.dbFile)).toThrow('simulated')

    const check = new Database(sb.dbFile)
    expect(readSchemaVersion(check)).toBe(8)
    expect(tableExists(check, 'schema_migrations')).toBe(false)
    expect(check.prepare(`SELECT COUNT(*) AS c FROM messages`).get()).toEqual({ c: 2 })
    expect(check.prepare(`SELECT message_id FROM favorites`).all()).toEqual([{ message_id: 1 }])
    check.exec(`DROP TRIGGER fail_v9`)
    check.close()

    const db = sb.open()
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(db.prepare(`SELECT COUNT(*) AS c FROM messages`).get()).toEqual({ c: 2 })
    expectHealthy(db)
  })
})

describe.each([9, 10] as const)('upgrade from the v%i schema as shipped', (version) => {
  it('keeps every row, with its id, and search still finds them', () => {
    const sb = shippedSandbox(version)
    const db = sb.open()
    expect(rowsOf(db)).toEqual(sb.rows)
    expect(hits(db, 'livequokka')).toEqual([1, 2])
    expect(hits(db, 'archivedquokka')).toEqual([3])
    // A meta row stays out of the full-text index.
    expect(hits(db, 'bookkeeping')).toEqual([])
    expectHealthy(db)
  })

  it('records every step, sets the version to the highest, and matches a new DB', () => {
    const sb = shippedSandbox(version)
    const db = sb.open()
    expect(appliedIds(db)).toEqual(MIGRATIONS.map((m) => m.id))
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(pendingMigrations(db)).toEqual([])
    const fresh = openVaultDb(path.join(sb.dir, 'fresh.db'))
    expect(shapeOf(db)).toEqual(shapeOf(fresh))
    fresh.close()
  })

  it('copies the file first, as that version', () => {
    const sb = shippedSandbox(version)
    const backups = path.join(sb.dir, 'backups')
    const opened = openVaultDbWithRecovery(sb.dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'ok' })
    opened.db!.close()
    const [pre] = listBackups(backups)
    expect(pre.reason).toBe('pre-migration')
    const copy = readOnly(path.join(backups, pre.name))
    expect(readSchemaVersion(copy)).toBe(version)
    expect(tableExists(copy, 'schema_migrations')).toBe(false)
    expect(rowsOf(copy).messages).toEqual(sb.rows.messages)
    copy.close()
  })
})

describe('early v9 builds', () => {
  it('lose the index the covering one replaced', () => {
    const sb = sandbox()
    const db = createShippedDb(sb.dbFile, 9)
    db.exec(`CREATE INDEX idx_messages_usage ON messages(api_msg_id)`)
    db.close()
    const migrated = sb.open()
    expect(tableExists(migrated, 'idx_messages_usage')).toBe(false)
    expect(tableExists(migrated, 'idx_messages_usage_cover')).toBe(true)
  })
})

describe('the runner', () => {
  it('applies every id not recorded, ascending, whatever order the list is in', () => {
    const { dbFile, rows } = shippedSandbox(10)
    const calls: number[] = []
    launch(dbFile, [step(13, 'health_c', calls), schemaMigrations, step(12, 'cap_b', calls)])
    const db = readOnly(dbFile)
    expect(calls).toEqual([12, 13])
    expect(appliedIds(db)).toEqual([11, 12, 13])
    expect(readSchemaVersion(db)).toBe(13)
    const stamps = db.prepare(`SELECT applied_at FROM schema_migrations`).all() as { applied_at: number }[]
    for (const { applied_at } of stamps) expect(applied_at).toBeGreaterThan(0)
    expect(rowsOf(db)).toEqual(rows)
    db.close()
  })

  it('runs nothing the second time, and leaves the record alone', () => {
    const { dbFile } = shippedSandbox(10)
    const calls: number[] = []
    const build = [schemaMigrations, step(12, 'cap_b', calls)]
    launch(dbFile, build)
    const stamps = () => {
      const db = readOnly(dbFile)
      const out = db.prepare(`SELECT id, applied_at FROM schema_migrations ORDER BY id`).all()
      db.close()
      return out
    }
    const first = stamps()
    launch(dbFile, build)
    expect(calls).toEqual([12])
    expect(stamps()).toEqual(first)
  })

  it('still runs a lower id merged after a higher one has shipped', () => {
    const { dbFile } = shippedSandbox(10)
    const calls: number[] = []
    launch(dbFile, [schemaMigrations, step(13, 'health_c', calls)])
    launch(dbFile, [schemaMigrations, step(12, 'cap_b', calls), step(13, 'health_c', calls)])
    expect(calls).toEqual([13, 12])
    const db = readOnly(dbFile)
    expect(appliedIds(db)).toEqual([11, 12, 13])
    expect(tableExists(db, 'cap_b')).toBe(true)
    // The lower step does not pull the version back down.
    expect(readSchemaVersion(db)).toBe(13)
    db.close()
  })

  const orders = [
    [12, 13, 14],
    [12, 14, 13],
    [13, 12, 14],
    [13, 14, 12],
    [14, 12, 13],
    [14, 13, 12],
  ]
  const tables: Record<number, string> = { 12: 'cap_b', 13: 'health_c', 14: 'why_d' }

  it.each(orders)('gives the same DB whichever order the branches land in: %i, %i, %i', (a, b, c) => {
    const { dbFile, dir, rows } = shippedSandbox(10)
    const calls: number[] = []
    let build: Migration[] = [schemaMigrations]
    for (const id of [a, b, c]) {
      build = [...build, step(id, tables[id], calls)]
      launch(dbFile, build)
    }
    expect(calls).toEqual([a, b, c])

    const straight = path.join(dir, 'straight.db')
    createShippedDb(straight, 10).close()
    launch(straight, [schemaMigrations, ...[12, 13, 14].map((id) => step(id, tables[id]))])

    const db = new Database(dbFile)
    const other = readOnly(straight)
    expect(shapeOf(db)).toEqual(shapeOf(other))
    expect(appliedIds(db)).toEqual(appliedIds(other))
    expect(readSchemaVersion(db)).toBe(14)
    expect(rowsOf(db)).toEqual(rows)
    expectHealthy(db)
    db.close()
    other.close()
  })

  it('rolls back only the step that failed', () => {
    const { dbFile, rows } = shippedSandbox(10)
    const calls: number[] = []
    const kept = step(12, 'cap_b', calls)
    const later = step(14, 'why_d', calls)
    const failing: Migration = {
      id: 13,
      up(db) {
        calls.push(13)
        db.exec(`CREATE TABLE health_half (x)`)
        db.exec(`UPDATE messages SET body = 'clobberedquokka'`)
        db.exec(`DELETE FROM plan_files`)
        db.exec(`UPDATE meta SET value = 'mirror' WHERE key = 'setting.archiveMode'`)
        throw new Error('simulated')
      },
    }
    expect(() => openVaultDb(dbFile, { migrations: [schemaMigrations, kept, failing, later] })).toThrow('simulated')
    expect(calls).toEqual([12, 13])

    const db = new Database(dbFile)
    expect(appliedIds(db)).toEqual([11, 12])
    expect(readSchemaVersion(db)).toBe(12)
    expect(tableExists(db, 'cap_b')).toBe(true)
    expect(tableExists(db, 'health_half')).toBe(false)
    expect(tableExists(db, 'why_d')).toBe(false)
    expect(rowsOf(db)).toEqual(rows)
    expect(hits(db, 'clobberedquokka')).toEqual([])
    expect(hits(db, 'livequokka')).toEqual([1, 2])
    expectHealthy(db)
    db.close()

    // With the step fixed, the next launch carries on from there.
    calls.length = 0
    launch(dbFile, [schemaMigrations, kept, step(13, 'health_c', calls), later])
    expect(calls).toEqual([13, 14])
    const fixed = readOnly(dbFile)
    expect(appliedIds(fixed)).toEqual([11, 12, 13, 14])
    expect(readSchemaVersion(fixed)).toBe(14)
    expect(rowsOf(fixed)).toEqual(rows)
    fixed.close()
  })

  it('stays at the baseline when the very first step fails', () => {
    const { dbFile, rows } = shippedSandbox(9)
    const failing: Migration = {
      id: 11,
      up(db) {
        schemaMigrations.up(db)
        throw new Error('simulated')
      },
    }
    expect(() => openVaultDb(dbFile, { migrations: [failing] })).toThrow('simulated')
    const db = readOnly(dbFile)
    expect(readSchemaVersion(db)).toBe(BASELINE_VERSION)
    expect(tableExists(db, 'schema_migrations')).toBe(false)
    expect(rowsOf(db)).toEqual(rows)
    db.close()
    launch(dbFile, [schemaMigrations])
    const again = readOnly(dbFile)
    expect(appliedIds(again)).toEqual([11])
    expect(rowsOf(again)).toEqual(rows)
    again.close()
  })

  it('reports a failed step as retryable at startup: nothing swapped, the copy kept, the retry works', () => {
    const { dbFile, dir, rows } = shippedSandbox(10)
    const backups = path.join(dir, 'backups')
    const broken: Migration = { id: 9000, up: (db) => db.exec(`CREATE TABLE cap_broken (`) }
    const opened = openVaultDbWithRecovery(dbFile, backups, new Date(), (f) =>
      openVaultDb(f, { migrations: [...MIGRATIONS, broken] }),
    )
    expect(opened.db).toBeNull()
    expect(opened.outcome).toEqual({ kind: 'retryable', code: 'SQLITE_ERROR', path: dbFile })
    expect(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([])
    expect(listBackups(backups).map((b) => b.reason)).toEqual(['pre-migration'])

    const again = openVaultDbWithRecovery(dbFile, backups)
    expect(again.outcome).toEqual({ kind: 'ok' })
    expect(rowsOf(again.db!)).toEqual(rows)
    again.db!.close()
  })

  it('re-reads live sessions in place after a reparse step, and leaves archived ones', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const live = path.join(sb.projectRoot, 'live.jsonl')
    const gone = path.join(sb.projectRoot, 'gone.jsonl')
    writeLines(live, [userLine('u-live', 'still here')])
    writeLines(gone, [userLine('u-gone', 'only copy')])
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: live })
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: gone })
    fs.rmSync(gone)
    reconcileMissing(db, sb.adapter, 'keep')
    db.close()

    const reparse: Migration = { id: 9000, up: () => {}, reparse: true }
    const again = openVaultDb(sb.dbFile, { migrations: [...MIGRATIONS, reparse] })
    const offsets = () =>
      again.prepare(`SELECT id, indexed_bytes > 0 AS parsed, archived_at IS NOT NULL AS archived FROM sessions ORDER BY id`).all() as {
        id: number
        parsed: number
        archived: number
      }[]
    const [liveRow, goneRow] = offsets()
    expect(liveRow).toMatchObject({ parsed: 0, archived: 0 })
    expect(goneRow).toMatchObject({ parsed: 1, archived: 1 })

    const result = await indexSessionFile(again, { projectId: pid, projectRoot: sb.projectRoot, filePath: live })
    expect(result.mode).toBe('full')
    // Replaced in place: no archived generation, and the session keeps its id.
    expect(offsets()).toEqual([{ ...liveRow, parsed: 1 }, goneRow])
    again.close()
  })
})

describe('a DB holding an id this build does not know', () => {
  it('is refused even when the id is below the latest this build knows', () => {
    const { dbFile } = shippedSandbox(10)
    const calls: number[] = []
    launch(dbFile, [schemaMigrations, step(12, 'cap_b'), step(13, 'health_c')])

    let thrown: unknown
    try {
      openVaultDb(dbFile, { migrations: [schemaMigrations, step(13, 'health_c', calls)] })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NewerSchemaError)
    expect((thrown as NewerSchemaError).version).toBe(12)
    expect(calls).toEqual([])
    const db = readOnly(dbFile)
    expect(appliedIds(db)).toEqual([11, 12, 13])
    db.close()
  })

  function withUnknownId() {
    const sb = sandbox()
    const db = sb.open()
    const backups = path.join(sb.dir, 'backups')
    return { ...sb, db, backups, unknown: SCHEMA_VERSION + 5 }
  }

  it('returns newer-build at startup, with the file and its folder untouched', () => {
    const { db, dbFile, dir, backups, unknown } = withUnknownId()
    db.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, 1)`).run(unknown)
    // Something is pending as well, so a check made only at the open would copy the file first.
    markStepPending(db)
    db.close()
    const bytes = fs.readFileSync(dbFile)
    const before = fs.readdirSync(dir).sort()

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.db).toBeNull()
    expect(opened.outcome).toEqual({ kind: 'newer-build', version: unknown, known: SCHEMA_VERSION })
    expect(fs.readFileSync(dbFile).equals(bytes)).toBe(true)
    expect(fs.readdirSync(dir).sort()).toEqual(before)
  })

  it('is not accepted as a backup, and recovery passes over it', () => {
    const { db, dbFile, backups, unknown } = withUnknownId()
    const good = snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, 1)`).run(unknown)
    const newer = snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 2)))
    db.close()
    expect(() => verifyBackup(path.join(backups, newer.name))).toThrowError(expect.objectContaining({ code: 'newer-schema' }))
    expect(() => verifyBackup(path.join(backups, good.name))).not.toThrow()

    fs.writeFileSync(dbFile, 'not a database, and long enough for SQLite to say so')
    for (const s of ['-wal', '-shm']) fs.rmSync(dbFile + s, { force: true })
    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.outcome).toMatchObject({ kind: 'recovered', from: good.name })
    opened.db!.close()
  })
})

describe('the pre-migration copy', () => {
  it('is skipped when nothing is pending', () => {
    const sb = sandbox()
    sb.open().close()
    const backups = path.join(sb.dir, 'backups')
    const opened = openVaultDbWithRecovery(sb.dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'ok' })
    opened.db!.close()
    expect(listBackups(backups)).toEqual([])
  })

  it('is made for a pending step even at the current version number', () => {
    const sb = sandbox()
    const db = sb.open()
    markStepPending(db)
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    db.close()
    const backups = path.join(sb.dir, 'backups')
    const opened = openVaultDbWithRecovery(sb.dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'ok' })
    expect(pendingMigrations(opened.db!)).toEqual([])
    opened.db!.close()
    expect(listBackups(backups).map((b) => b.reason)).toEqual(['pre-migration'])
  })
})

describe('migration files', () => {
  const noop = () => {}
  const dir = fileURLToPath(new URL('../../electron/migrations', import.meta.url))

  it('number the schema: the latest file is SCHEMA_VERSION', () => {
    const ids = fs.readdirSync(dir).map((f) => Number(f.slice(0, 4)))
    expect(MIGRATIONS.map((m) => m.id)).toEqual(ids.sort((a, b) => a - b))
    expect(SCHEMA_VERSION).toBe(Math.max(...ids))
    expect(MIGRATIONS[0].id).toBe(BASELINE_VERSION + 1)
  })

  it('are sorted by id whatever order they are found in', () => {
    const found = checkMigrations({
      './migrations/0013-c.ts': { id: 13, up: noop },
      './migrations/0012-b.ts': { id: 12, up: noop },
    })
    expect(found.map((m) => m.id)).toEqual([12, 13])
  })

  it('fail the build when two branches took one id', () => {
    expect(() =>
      checkMigrations({
        './migrations/0012-capture.ts': { id: 12, up: noop },
        './migrations/0012-health.ts': { id: 12, up: noop },
      }),
    ).toThrow(/both claim id 12/)
  })

  it.each([
    ['a number that does not match the file', './migrations/0012-a.ts', 13],
    ['a file name with no number', './migrations/helpers.ts', 12],
    ['an id at the baseline', './migrations/0010-a.ts', 10],
  ])('fail the build on %s', (_what, file, id) => {
    expect(() => checkMigrations({ [file]: { id, up: noop } })).toThrow()
  })

  it('cannot change the frozen baseline', () => {
    const sb = sandbox()
    const baseline = openVaultDb(sb.dbFile, { migrations: [] })
    const shipped = createShippedDb(path.join(sb.dir, 'shipped.db'), 10)
    const schema = (db: DbHandle) =>
      (db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as { sql: string | null }[]).map(
        (o) => ({ ...o, sql: o.sql?.replace(/\s+/g, ' ') }),
      )
    expect(schema(baseline)).toEqual(schema(shipped))
    expect(readSchemaVersion(baseline)).toBe(BASELINE_VERSION)
    baseline.close()
    shipped.close()
  })

  it('only add, under a feature prefix, and hang side tables off sessions with a cascade', () => {
    const { dbFile, dir: root, rows } = shippedSandbox(10)
    const shipped = createShippedDb(path.join(root, 'shipped.db'), 10)
    const before = shapeOf(shipped)
    shipped.close()

    const db = openVaultDb(dbFile)
    const after = shapeOf(db)
    for (const object of before.objects) expect(after.objects).toContainEqual(object)
    for (const [table, columns] of Object.entries(before.columns)) expect(after.columns[table]).toEqual(expect.arrayContaining(columns))
    expect(rowsOf(db)).toEqual(rows)

    const added = Object.keys(after.columns).filter((t) => !(t in before.columns))
    for (const table of added.filter((t) => t !== 'schema_migrations')) {
      expect(table).toMatch(/^(cap|health|why|secret|policy)_/)
      if (!after.columns[table].includes('session_id')) continue
      const keys = db.pragma(`foreign_key_list(${table})`) as { from: string; table: string; on_delete: string }[]
      expect(keys).toContainEqual(expect.objectContaining({ from: 'session_id', table: 'sessions', on_delete: 'CASCADE' }))
    }
    db.close()
  })
})

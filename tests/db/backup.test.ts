import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backupName,
  dailyBackupDue,
  DAILY_MS,
  isBackupName,
  listBackups,
  openVaultDbWithRecovery,
  pruneBackups,
  restoreBackup,
  retryCause,
  snapshot,
  verifyBackup,
} from '../../electron/backup'
import { openVaultDb, readSchemaVersion, SCHEMA_VERSION, setSetting, type DbHandle } from '../../electron/db'
import { indexSessionFile } from '../../electron/indexer'
import { addFavorite, listFavorites, removeFavorite } from '../../electron/queries'
import { assistantLine, sandbox, userLine, writeLines } from './helpers'

async function seeded() {
  const sb = sandbox()
  const db = sb.open()
  const pid = sb.project(db)
  const file = path.join(sb.projectRoot, 's1.jsonl')
  writeLines(file, [userLine('u1', 'keep this prompt'), assistantLine('a1', 'an answer')])
  await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
  const { id } = db.prepare(`SELECT id FROM messages WHERE msg_key = 'u1'`).get() as { id: number }
  addFavorite(db, id)
  const backups = path.join(sb.dir, 'backups')
  return { ...sb, db, backups }
}

const count = (db: DbHandle, table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c

function readOnly(file: string) {
  return new Database(file, { readonly: true, fileMustExist: true })
}

const coded = (code: string) => Object.assign(new Error(`${code}: simulated`), { code })
const quarantinedFiles = (dbFile: string) => fs.readdirSync(path.dirname(dbFile)).filter((f) => f.includes('.corrupt-'))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('snapshots', () => {
  it('writes a complete, openable copy of a live DB and leaves no temp file', async () => {
    const { db, backups } = await seeded()
    const b = snapshot(db, backups, 'manual', new Date(Date.UTC(2026, 9, 27, 3, 15, 0)))
    expect(b.name).toBe('vault-20261027-031500-manual.db')
    expect(fs.readdirSync(backups)).toEqual([b.name])
    const copy = readOnly(path.join(backups, b.name))
    expect(count(copy, 'messages')).toBe(count(db, 'messages'))
    expect(count(copy, 'favorites')).toBe(1)
    expect(readSchemaVersion(copy)).toBe(SCHEMA_VERSION)
    copy.close()
  })

  it('never reuses a name taken in the same second', async () => {
    const { db, backups } = await seeded()
    const at = new Date(Date.UTC(2026, 9, 27, 3, 15, 0))
    const a = snapshot(db, backups, 'manual', at)
    const b = snapshot(db, backups, 'manual', at)
    expect(a.name).not.toBe(b.name)
    expect(listBackups(backups)).toHaveLength(2)
  })

  it('lists newest first, ignores other files, prunes with sidecars', async () => {
    const { db, backups } = await seeded()
    for (let d = 1; d <= 4; d++) snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, d)))
    fs.writeFileSync(path.join(backups, 'notes.txt'), 'x')
    fs.writeFileSync(path.join(backups, `${backupName(new Date(Date.UTC(2026, 9, 9)), 'daily')}.tmp`), 'partial')
    const oldest = listBackups(backups).at(-1)!.name
    fs.writeFileSync(path.join(backups, `${oldest}-wal`), 'wal')

    expect(listBackups(backups).map((b) => b.createdAt)).toEqual(
      [4, 3, 2, 1].map((d) => Date.UTC(2026, 9, d)),
    )
    expect(pruneBackups(backups, 3)).toEqual([oldest])
    expect(fs.existsSync(path.join(backups, `${oldest}-wal`))).toBe(false)
    expect(listBackups(backups)).toHaveLength(3)
    // 0 means "off": it stops new backups but never deletes existing ones.
    expect(pruneBackups(backups, 0)).toEqual([])
  })

  it('rotates only dailies, so a safety copy outlives any number of them', async () => {
    const { db, backups } = await seeded()
    const manual = snapshot(db, backups, 'manual', new Date(Date.UTC(2026, 8, 1)))
    const purge = snapshot(db, backups, 'pre-purge', new Date(Date.UTC(2026, 8, 2)))
    const migration = snapshot(db, backups, 'pre-migration', new Date(Date.UTC(2026, 8, 3)))
    const restore = snapshot(db, backups, 'pre-restore', new Date(Date.UTC(2026, 8, 4)))
    for (let d = 1; d <= 5; d++) snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, d)))

    pruneBackups(backups, 3)
    const left = listBackups(backups).map((b) => b.name)
    expect(left).toEqual(expect.arrayContaining([manual.name, purge.name, migration.name, restore.name]))
    expect(listBackups(backups).filter((b) => b.reason === 'daily').map((b) => b.createdAt)).toEqual(
      [5, 4, 3].map((d) => Date.UTC(2026, 9, d)),
    )
  })

  it('keeps the latest 2 of each safety reason, whatever the daily count', async () => {
    const { db, backups } = await seeded()
    const reasons = ['manual', 'pre-purge', 'pre-migration', 'pre-restore'] as const
    for (const reason of reasons) {
      for (let d = 1; d <= 4; d++) snapshot(db, backups, reason, new Date(Date.UTC(2026, 9, d)))
    }
    pruneBackups(backups, 1)
    for (const reason of reasons) {
      expect(listBackups(backups).filter((b) => b.reason === reason).map((b) => b.createdAt)).toEqual(
        [4, 3].map((d) => Date.UTC(2026, 9, d)),
      )
    }
  })

  it('knows when the daily snapshot is due', async () => {
    const { db, backups } = await seeded()
    const now = Date.UTC(2026, 9, 27, 12)
    expect(dailyBackupDue(backups, 3, now)).toBe(true)
    snapshot(db, backups, 'manual', new Date(now - 60_000))
    expect(dailyBackupDue(backups, 3, now)).toBe(false)
    expect(dailyBackupDue(backups, 3, now + DAILY_MS)).toBe(true)
    expect(dailyBackupDue(backups, 0, now + DAILY_MS)).toBe(false)
  })

  it('accepts only bare backup names from IPC', () => {
    expect(isBackupName('vault-20261027-031500-daily.db')).toBe(true)
    expect(isBackupName('../vault.db')).toBe(false)
    expect(isBackupName('/tmp/vault-20261027-031500-daily.db')).toBe(false)
    expect(isBackupName('vault-20261027-031500-evil.db')).toBe(false)
    expect(isBackupName(42)).toBe(false)
  })
})

describe('restore', () => {
  it('swaps the backup in and keeps the replaced DB as a pre-restore backup', async () => {
    const { db, dbFile, backups } = await seeded()
    const good = snapshot(db, backups, 'manual', new Date(Date.UTC(2026, 9, 1)))
    removeFavorite(db, 'u1')
    expect(listFavorites(db)).toHaveLength(0)
    db.close()

    const previous = restoreBackup(dbFile, backups, good.name, new Date(Date.UTC(2026, 9, 2)))
    expect(previous?.reason).toBe('pre-restore')
    // The pre-restore file is the live DB, still in WAL mode: checking it must not leave
    // the -wal/-shm that a read-only open creates (checked before anything else opens it).
    verifyBackup(path.join(backups, previous!.name))
    expect(fs.readdirSync(backups).filter((f) => f.startsWith(previous!.name))).toEqual([previous!.name])
    const restored = readOnly(dbFile)
    expect(listFavorites(restored)).toHaveLength(1)
    restored.close()
    const before = readOnly(path.join(backups, previous!.name))
    expect(count(before, 'favorites')).toBe(0)
    before.close()
    // The chosen backup itself is untouched.
    expect(listBackups(backups).map((b) => b.name)).toContain(good.name)
  })

  it('refuses files that are not vault DBs or come from a newer schema', async () => {
    const { db, backups } = await seeded()
    const b = snapshot(db, backups, 'manual')
    const newer = path.join(backups, backupName(new Date(Date.UTC(2030, 0, 1)), 'manual'))
    fs.copyFileSync(path.join(backups, b.name), newer)
    const w = new Database(newer)
    w.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION + 1))
    w.close()
    expect(() => verifyBackup(newer)).toThrow(/schema/)

    const junk = path.join(backups, backupName(new Date(Date.UTC(2031, 0, 1)), 'manual'))
    fs.writeFileSync(junk, 'not sqlite at all, just text that is long enough to look like a header')
    expect(() => verifyBackup(junk)).toThrow()
    expect(() => verifyBackup(path.join(backups, 'vault-20200101-000000-daily.db'))).toThrow(/not found/)
  })

  it('puts the live DB back when the backup cannot be installed', async () => {
    const { db, dbFile, backups } = await seeded()
    const good = snapshot(db, backups, 'manual', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    fs.writeFileSync(`${dbFile}-wal`, 'the wal')
    const copy = fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      if (String(to).endsWith('.restoring')) throw coded('ENOSPC')
      copy(from, to, mode)
    })

    expect(() => restoreBackup(dbFile, backups, good.name)).toThrow(/ENOSPC/)
    vi.restoreAllMocks()
    expect(fs.readFileSync(`${dbFile}-wal`, 'utf8')).toBe('the wal')
    fs.rmSync(`${dbFile}-wal`)
    expect(listBackups(backups).map((b) => b.name)).toEqual([good.name])
    expect(fs.existsSync(`${dbFile}.restoring`)).toBe(false)
    const live = readOnly(dbFile)
    expect(listFavorites(live)).toHaveLength(1)
    live.close()
  })

  it('leaves every file in place when the live DB will not move', async () => {
    const { db, dbFile, backups } = await seeded()
    const good = snapshot(db, backups, 'manual', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    fs.writeFileSync(`${dbFile}-wal`, 'the wal')
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === dbFile) throw coded('EBUSY')
      rename(from, to)
    })

    expect(() => restoreBackup(dbFile, backups, good.name)).toThrow(/EBUSY/)
    vi.restoreAllMocks()
    expect(fs.readFileSync(`${dbFile}-wal`, 'utf8')).toBe('the wal')
    expect(listBackups(backups).map((b) => b.name)).toEqual([good.name])
  })

  it('finds the old DB at the next launch even when it could not be put back', async () => {
    const { db, dbFile, backups } = await seeded()
    const good = snapshot(db, backups, 'manual', new Date(Date.UTC(2026, 9, 1)))
    removeFavorite(db, 'u1')
    db.close()
    const { copyFileSync: copy, renameSync: rename } = fs
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      if (String(to).endsWith('.restoring')) throw coded('ENOSPC')
      copy(from, to, mode)
    })
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === dbFile) throw coded('EPERM')
      rename(from, to)
    })

    expect(() => restoreBackup(dbFile, backups, good.name, new Date(Date.UTC(2026, 9, 2)))).toThrow(/ENOSPC/)
    vi.restoreAllMocks()
    expect(fs.existsSync(dbFile)).toBe(false)

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.outcome).toMatchObject({ kind: 'recovered', from: 'vault-20261002-000000-pre-restore.db', quarantined: null })
    // That file is the DB as the user left it, so the favorite they had removed stays removed.
    expect(listFavorites(opened.db!)).toHaveLength(0)
    opened.db!.close()
  })
})

describe('a launch that finds no DB', () => {
  it('creates one quietly when nothing says there ever was one', () => {
    const sb = sandbox()
    const opened = openVaultDbWithRecovery(sb.dbFile, path.join(sb.dir, 'backups'))
    expect(opened.outcome).toEqual({ kind: 'ok' })
    expect(count(opened.db!, 'messages')).toBe(0)
    opened.db!.close()
  })

  it('restores the newest usable backup and says so', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    const newest = snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 2)))
    db.close()
    fs.writeFileSync(path.join(backups, newest.name), 'garbage'.repeat(200))
    fs.rmSync(dbFile)

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'recovered', from: 'vault-20261001-000000-daily.db', quarantined: null })
    expect(listFavorites(opened.db!)).toHaveLength(1)
    opened.db!.close()

    // That was a one-off: the next launch is an ordinary one.
    const again = openVaultDbWithRecovery(dbFile, backups)
    expect(again.outcome).toEqual({ kind: 'ok' })
    again.db!.close()
  })

  it('finishes a recovery that stopped after the quarantine (a crash, a power cut)', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    const corrupt = `${dbFile}.corrupt-2026-10-02T00-00-00-000Z`
    fs.writeFileSync(corrupt, 'garbage'.repeat(200))
    fs.writeFileSync(`${dbFile}.corrupt-2026-09-01T00-00-00-000Z`, 'an older one')
    fs.writeFileSync(`${corrupt}-wal`, 'its wal')
    fs.rmSync(dbFile)

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'recovered', from: 'vault-20261001-000000-daily.db', quarantined: corrupt })
    expect(listFavorites(opened.db!)).toHaveLength(1)
    opened.db!.close()
    expect(fs.readFileSync(corrupt, 'utf8')).toMatch(/^garbage/)
  })

  it('says so when only a quarantined file is left', async () => {
    const { db, dbFile, backups } = await seeded()
    db.close()
    const corrupt = `${dbFile}.corrupt-2026-10-02T00-00-00-000Z`
    fs.renameSync(dbFile, corrupt)

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'rebuilt', quarantined: corrupt })
    expect(count(opened.db!, 'messages')).toBe(0)
    opened.db!.close()
  })

  it('says so when no backup is usable either', async () => {
    const { db, dbFile, backups } = await seeded()
    const only = snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    fs.writeFileSync(path.join(backups, only.name), 'garbage'.repeat(200))
    fs.rmSync(dbFile)

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'rebuilt', quarantined: null })
    opened.db!.close()
    expect(fs.existsSync(path.join(backups, only.name))).toBe(true)
  })

  it('creates nothing when the backup cannot be installed, so the next attempt recovers it', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    fs.rmSync(dbFile)
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw coded('ENOSPC')
    })

    const full = openVaultDbWithRecovery(dbFile, backups)
    copy.mockRestore()
    expect(full.outcome).toEqual({ kind: 'retryable', code: 'ENOSPC', path: dbFile })
    expect(fs.existsSync(dbFile)).toBe(false)

    const again = openVaultDbWithRecovery(dbFile, backups)
    expect(again.outcome.kind).toBe('recovered')
    again.db!.close()
  })
})

describe('startup recovery', () => {
  it('replaces a DB that cannot be opened with the newest usable backup', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    const newest = snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 2)))
    db.close()
    // The newest backup is damaged too: recovery must fall back to the next one.
    fs.writeFileSync(path.join(backups, newest.name), 'garbage'.repeat(200))
    fs.writeFileSync(dbFile, 'garbage'.repeat(200))

    const { db: opened, outcome } = openVaultDbWithRecovery(dbFile, backups)
    expect(outcome.kind).toBe('recovered')
    if (outcome.kind !== 'recovered') throw new Error('unreachable')
    expect(outcome.from).toBe('vault-20261001-000000-daily.db')
    expect(listFavorites(opened!)).toHaveLength(1)
    // The broken file is kept for manual recovery, not deleted.
    expect(fs.readFileSync(outcome.quarantined, 'utf8')).toMatch(/^garbage/)
    opened!.close()
  })

  it('rebuilds an empty DB only when no backup is usable', async () => {
    const { db, dbFile, backups } = await seeded()
    db.close()
    fs.writeFileSync(dbFile, 'garbage'.repeat(200))
    const { db: opened, outcome } = openVaultDbWithRecovery(dbFile, backups)
    expect(outcome.kind).toBe('rebuilt')
    expect(count(opened!, 'messages')).toBe(0)
    opened!.close()
  })

  it('copies the old file before a schema migration (unless backups are off)', async () => {
    const sb = sandbox()
    const backups = path.join(sb.dir, 'backups')
    const legacy = new Database(sb.dbFile)
    legacy.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '8');`)
    legacy.close()

    const { db, outcome } = openVaultDbWithRecovery(sb.dbFile, backups)
    expect(outcome.kind).toBe('ok')
    expect(readSchemaVersion(db!)).toBe(SCHEMA_VERSION)
    const [pre] = listBackups(backups)
    expect(pre.reason).toBe('pre-migration')
    const copy = readOnly(path.join(backups, pre.name))
    expect(readSchemaVersion(copy)).toBe(8)
    copy.close()

    // Same upgrade with backups turned off: no copy.
    db!.prepare(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`).run()
    setSetting(db!, 'backupKeep', '0')
    db!.close()
    fs.rmSync(backups, { recursive: true })
    const again = openVaultDbWithRecovery(sb.dbFile, backups)
    expect(listBackups(backups)).toHaveLength(0)
    again.db!.close()
  })

  it('recovers from SQLITE_CORRUPT as it does from SQLITE_NOTADB', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    // A valid header over a destroyed schema page reads as malformed, not as "not a DB".
    const bytes = fs.readFileSync(dbFile)
    bytes.fill(0xa5, 100, bytes.length)
    fs.writeFileSync(dbFile, bytes)

    const { db: opened, outcome } = openVaultDbWithRecovery(dbFile, backups)
    expect(outcome.kind).toBe('recovered')
    expect(listFavorites(opened!)).toHaveLength(1)
    opened!.close()
  })

  it('counts extended corruption codes as corruption', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    let calls = 0
    const opened = openVaultDbWithRecovery(dbFile, backups, new Date(), (f) => {
      if (calls++ === 0) throw coded('SQLITE_CORRUPT_VTAB')
      return openVaultDb(f)
    })
    expect(opened.outcome.kind).toBe('recovered')
    opened.db!.close()
  })
})

describe('an open that fails for any other reason swaps nothing', () => {
  it('leaves a healthy DB alone while another connection holds the write lock', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    // One schema behind, so opening has to write: a current DB would open without the lock.
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 1))
    // No pre-migration copy: this is about the open, and Windows may refuse to copy a file
    // this connection holds open.
    setSetting(db, 'backupKeep', '0')
    db.exec('BEGIN IMMEDIATE')

    const opened = openVaultDbWithRecovery(dbFile, backups, new Date(), (f) => openVaultDb(f, { busyTimeoutMs: 50 }))
    expect(opened.db).toBeNull()
    expect(opened.outcome).toEqual({ kind: 'retryable', code: 'SQLITE_BUSY', path: dbFile })
    expect(quarantinedFiles(dbFile)).toEqual([])

    // The retry the dialog offers: the lock is gone and the same file opens with its data.
    db.exec('ROLLBACK')
    db.close()
    const again = openVaultDbWithRecovery(dbFile, backups)
    expect(again.outcome.kind).toBe('ok')
    expect(listFavorites(again.db!)).toHaveLength(1)
    again.db!.close()
  })

  it.each(['SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_IOERR_WRITE', 'SQLITE_READONLY', 'SQLITE_CANTOPEN', 'EACCES', 'ENOSPC'])(
    '%s returns retryable with the code and keeps the file',
    async (code) => {
      const { db, dbFile, backups } = await seeded()
      snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
      db.close()
      const bytes = fs.readFileSync(dbFile)

      const opened = openVaultDbWithRecovery(dbFile, backups, new Date(), () => {
        throw coded(code)
      })
      expect(opened.db).toBeNull()
      expect(opened.outcome).toMatchObject({ kind: 'retryable', code })
      expect(fs.readFileSync(dbFile).equals(bytes)).toBe(true)
      expect(quarantinedFiles(dbFile)).toEqual([])
    },
  )

  it('reports an error with no code as retryable too', async () => {
    const { db, dbFile, backups } = await seeded()
    db.close()
    const opened = openVaultDbWithRecovery(dbFile, backups, new Date(), () => {
      throw new Error('boom')
    })
    expect(opened.outcome).toMatchObject({ kind: 'retryable', code: 'UNKNOWN' })
    expect(quarantinedFiles(dbFile)).toEqual([])
  })

  it('names the cause so the dialog can say what to do', () => {
    expect(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'EBUSY'].map(retryCause)).toEqual(Array(4).fill('busy'))
    expect(['SQLITE_FULL', 'ENOSPC', 'EDQUOT'].map(retryCause)).toEqual(Array(3).fill('full'))
    expect(['SQLITE_READONLY', 'SQLITE_READONLY_DIRECTORY', 'SQLITE_CANTOPEN', 'EACCES', 'EPERM', 'EROFS'].map(retryCause)).toEqual(
      Array(6).fill('denied'),
    )
    expect(['SQLITE_IOERR', 'UNKNOWN'].map(retryCause)).toEqual(Array(2).fill('other'))
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a read-only folder as retryable and keeps the DB',
    async () => {
      const { db, dbFile, dir, backups } = await seeded()
      db.close()
      const bytes = fs.readFileSync(dbFile)
      fs.chmodSync(dir, 0o555)
      try {
        const opened = openVaultDbWithRecovery(dbFile, backups)
        opened.db?.close()
        expect(opened.db).toBeNull()
        expect(opened.outcome.kind).toBe('retryable')
        if (opened.outcome.kind !== 'retryable') throw new Error('unreachable')
        expect(retryCause(opened.outcome.code)).toBe('denied')
      } finally {
        fs.chmodSync(dir, 0o755)
      }
      expect(fs.readFileSync(dbFile).equals(bytes)).toBe(true)
    },
  )

  // SQLite opens a file it may not write read-only without saying so, and for a current
  // schema nothing at open time writes: only the first INSERT would have found out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a read-only DB file in a writable folder as retryable and keeps it',
    async () => {
      const { db, dbFile, backups } = await seeded()
      db.close()
      const bytes = fs.readFileSync(dbFile)
      fs.chmodSync(dbFile, 0o444)
      try {
        const opened = openVaultDbWithRecovery(dbFile, backups)
        opened.db?.close()
        expect(opened.db).toBeNull()
        expect(opened.outcome).toMatchObject({ kind: 'retryable', path: dbFile })
        if (opened.outcome.kind !== 'retryable') throw new Error('unreachable')
        expect(retryCause(opened.outcome.code)).toBe('denied')
        expect(quarantinedFiles(dbFile)).toEqual([])
      } finally {
        fs.chmodSync(dbFile, 0o644)
      }
      expect(fs.readFileSync(dbFile).equals(bytes)).toBe(true)

      // The retry the dialog offers, once the permission is back.
      const again = openVaultDbWithRecovery(dbFile, backups)
      expect(again.outcome.kind).toBe('ok')
      expect(listFavorites(again.db!)).toHaveLength(1)
      setSetting(again.db!, 'autoUpdate', 'off')
      again.db!.close()
    },
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names a sidecar left read-only, which fails the open just the same',
    async () => {
      const { db, dbFile, backups } = await seeded()
      db.close()
      // What an earlier build's open left: SQLite gives sidecars the mode of the DB file.
      fs.chmodSync(dbFile, 0o444)
      const earlier = new Database(dbFile)
      earlier.prepare(`SELECT 1 FROM meta`).get()
      earlier.close()
      fs.chmodSync(dbFile, 0o644)

      const opened = openVaultDbWithRecovery(dbFile, backups)
      opened.db?.close()
      expect(opened.outcome).toMatchObject({ kind: 'retryable', code: 'EACCES', path: expect.stringMatching(/vault\.db-(wal|shm)$/) })
    },
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'catches a handle that cannot write even when the permissions look fine',
    async () => {
      const { db, dbFile, backups } = await seeded()
      db.close()
      fs.chmodSync(dbFile, 0o444)
      vi.spyOn(fs, 'accessSync').mockImplementation(() => {})
      try {
        const opened = openVaultDbWithRecovery(dbFile, backups)
        opened.db?.close()
        expect(opened.db).toBeNull()
        expect(opened.outcome).toMatchObject({ kind: 'retryable', path: dbFile })
        if (opened.outcome.kind !== 'retryable') throw new Error('unreachable')
        expect(opened.outcome.code).toMatch(/^SQLITE_READONLY/)
      } finally {
        fs.chmodSync(dbFile, 0o644)
      }
    },
  )

  it('does not wait for the first write to report a lock on a current DB', async () => {
    const { db, dbFile, backups } = await seeded()
    db.exec('BEGIN IMMEDIATE')
    const opened = openVaultDbWithRecovery(dbFile, backups, new Date(), (f) => openVaultDb(f, { busyTimeoutMs: 50 }))
    db.exec('ROLLBACK')
    expect(opened.outcome).toEqual({ kind: 'retryable', code: 'SQLITE_BUSY', path: dbFile })
  })

  it('does not migrate when the pre-migration copy cannot be made', async () => {
    const { db, dbFile, backups } = await seeded()
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 1))
    db.close()
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation((_from, to) => {
      fs.writeFileSync(to, 'partial')
      throw coded('ENOSPC')
    })
    const opened = openVaultDbWithRecovery(dbFile, backups)
    copy.mockRestore()
    expect(opened.db).toBeNull()
    // The dialog points at the folder that needs the space, not at the DB.
    expect(opened.outcome).toEqual({ kind: 'retryable', code: 'ENOSPC', path: backups })
    // A partial copy must not eat the space the retry needs.
    expect(fs.readdirSync(backups)).toEqual([])
    const check = readOnly(dbFile)
    expect(readSchemaVersion(check)).toBe(SCHEMA_VERSION - 1)
    check.close()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names the backup folder when that is what cannot be written',
    async () => {
      const { db, dbFile, backups } = await seeded()
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 1))
      db.close()
      fs.mkdirSync(backups)
      fs.chmodSync(backups, 0o555)
      try {
        const opened = openVaultDbWithRecovery(dbFile, backups)
        expect(opened.outcome).toEqual({ kind: 'retryable', code: 'EACCES', path: backups })
      } finally {
        fs.chmodSync(backups, 0o755)
      }
    },
  )
})

describe('a migration never runs without its copy', () => {
  async function oneBehind() {
    const { db, dbFile, backups } = await seeded()
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION - 1))
    return { db, dbFile, backups }
  }
  const versionOf = (dbFile: string) => {
    const check = readOnly(dbFile)
    const version = readSchemaVersion(check)
    check.close()
    return version
  }

  it(
    'refuses when a lock outlasts the version check, even if it would be gone by the open',
    async () => {
      const { db, dbFile, backups } = await oneBehind()
      db.pragma('locking_mode = EXCLUSIVE')
      setSetting(db, 'autoUpdate', 'off')

      const opened = openVaultDbWithRecovery(dbFile, backups)
      opened.db?.close()
      expect(opened.outcome).toEqual({ kind: 'retryable', code: 'SQLITE_BUSY', path: dbFile })
      expect(listBackups(backups)).toEqual([])
      db.close()
      expect(versionOf(dbFile)).toBe(SCHEMA_VERSION - 1)
    },
    20_000,
  )

  it('keeps the version it read when a sidecar cannot be cleaned up (antivirus, an indexer)', async () => {
    const { db, dbFile, backups } = await oneBehind()
    db.close()
    const rm = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation((p, opts) => {
      if (String(p).endsWith('-shm')) throw coded('EPERM')
      rm(p, opts)
    })

    const opened = openVaultDbWithRecovery(dbFile, backups)
    vi.restoreAllMocks()
    expect(opened.outcome).toEqual({ kind: 'ok' })
    expect(listBackups(backups).map((b) => b.reason)).toEqual(['pre-migration'])
    opened.db!.close()
  })

  it('covers a DB with tables and no version, which the legacy migration rebuilds', () => {
    const sb = sandbox()
    const backups = path.join(sb.dir, 'backups')
    const legacy = new Database(sb.dbFile)
    legacy.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY, project_id INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id INTEGER, body TEXT);
      INSERT INTO messages (body) VALUES ('sole copy');`)
    legacy.close()

    const opened = openVaultDbWithRecovery(sb.dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'ok' })
    expect(count(opened.db!, 'messages')).toBe(0)
    opened.db!.close()
    const [pre] = listBackups(backups)
    expect(pre.reason).toBe('pre-migration')
    const copy = readOnly(path.join(backups, pre.name))
    expect(count(copy, 'messages')).toBe(1)
    copy.close()
  })

  it('needs no copy of a file with nothing in it', () => {
    const sb = sandbox()
    const backups = path.join(sb.dir, 'backups')
    fs.writeFileSync(sb.dbFile, '')
    const opened = openVaultDbWithRecovery(sb.dbFile, backups)
    expect(opened.outcome).toEqual({ kind: 'ok' })
    expect(readSchemaVersion(opened.db!)).toBe(SCHEMA_VERSION)
    opened.db!.close()
    expect(listBackups(backups)).toEqual([])
  })
})

describe('quarantine', () => {
  it('leaves the file untouched and reports failure when the rename fails', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    const garbage = Buffer.from('garbage'.repeat(200))
    fs.writeFileSync(dbFile, garbage)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw coded('EACCES')
    })

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.db).toBeNull()
    expect(opened.outcome).toMatchObject({ kind: 'retryable', code: 'EACCES' })
    expect(fs.readFileSync(dbFile).equals(garbage)).toBe(true)
  })

  it('moves everything back when one file will not move', async () => {
    const { db, dbFile, backups } = await seeded()
    db.close()
    fs.writeFileSync(dbFile, 'garbage'.repeat(200))
    fs.writeFileSync(`${dbFile}-wal`, 'the wal')
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === dbFile) throw coded('EBUSY')
      rename(from, to)
    })

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.outcome).toMatchObject({ kind: 'retryable', code: 'EBUSY' })
    expect(fs.readFileSync(dbFile, 'utf8')).toMatch(/^garbage/)
    expect(fs.readFileSync(`${dbFile}-wal`, 'utf8')).toBe('the wal')
    expect(quarantinedFiles(dbFile)).toEqual([])
  })

  it('puts a corrupt DB back when the backup cannot be installed, so the next attempt recovers it', async () => {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.close()
    fs.writeFileSync(dbFile, 'garbage'.repeat(200))
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw coded('ENOSPC')
    })

    const full = openVaultDbWithRecovery(dbFile, backups)
    copy.mockRestore()
    expect(full.db).toBeNull()
    expect(full.outcome).toMatchObject({ kind: 'retryable', code: 'ENOSPC' })
    expect(fs.readFileSync(dbFile, 'utf8')).toMatch(/^garbage/)
    expect(quarantinedFiles(dbFile)).toEqual([])

    // Space freed: the next launch recovers instead of opening an empty DB as "ok".
    const again = openVaultDbWithRecovery(dbFile, backups)
    expect(again.outcome.kind).toBe('recovered')
    expect(listFavorites(again.db!)).toHaveLength(1)
    again.db!.close()
  })

  it('puts a corrupt DB back when not even an empty one can be created', async () => {
    const { db, dbFile, backups } = await seeded()
    db.close()
    fs.writeFileSync(dbFile, 'garbage'.repeat(200))
    const opened = openVaultDbWithRecovery(dbFile, backups, new Date(), () => {
      throw coded('SQLITE_FULL')
    })
    expect(opened.db).toBeNull()
    expect(opened.outcome).toMatchObject({ kind: 'retryable', code: 'SQLITE_FULL' })
    expect(fs.readFileSync(dbFile, 'utf8')).toMatch(/^garbage/)
    expect(quarantinedFiles(dbFile)).toEqual([])
  })
})

describe('a DB from a newer build', () => {
  async function newer() {
    const { db, dbFile, backups } = await seeded()
    snapshot(db, backups, 'daily', new Date(Date.UTC(2026, 9, 1)))
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION + 1))
    db.close()
    return { dbFile, backups }
  }

  it('is refused without a write, a quarantine or a backup', async () => {
    const { dbFile, backups } = await newer()
    const bytes = fs.readFileSync(dbFile)
    const before = fs.readdirSync(path.dirname(dbFile)).sort()
    const backupsBefore = fs.readdirSync(backups).sort()

    const opened = openVaultDbWithRecovery(dbFile, backups)
    expect(opened.db).toBeNull()
    expect(opened.outcome).toEqual({ kind: 'newer-build', version: SCHEMA_VERSION + 1, known: SCHEMA_VERSION })
    expect(fs.readFileSync(dbFile).equals(bytes)).toBe(true)
    expect(fs.readdirSync(path.dirname(dbFile)).sort()).toEqual(before)
    expect(fs.readdirSync(backups).sort()).toEqual(backupsBefore)
  })

  it('is refused by openVaultDb too, for a read that the check before it could not make', async () => {
    const { dbFile } = await newer()
    expect(() => openVaultDb(dbFile)).toThrow(/schema/)
    const check = readOnly(dbFile)
    expect(readSchemaVersion(check)).toBe(SCHEMA_VERSION + 1)
    check.close()
  })
})

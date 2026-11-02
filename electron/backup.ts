import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getSetting, NewerSchemaError, openVaultDb, readSchemaVersion, SCHEMA_VERSION, type DbHandle } from './db.js'
import { BACKUP_KEEP_CHOICES, DEFAULT_BACKUP_KEEP, type BackupFile, type BackupReason } from '../shared/ipc.js'

/**
 * Snapshots of the vault DB in `<userData>/backups`. In Keep mode the DB is the only
 * copy of transcripts Claude Code deleted, so it gets the protection a sole copy needs:
 * a daily snapshot, one before every destructive step, and recovery from the newest
 * snapshot when the DB cannot be opened. Nothing here imports Electron, so the logic is
 * tested directly against SQLite.
 */

/** A daily snapshot is due when the newest backup is older than this. */
export const DAILY_MS = 24 * 60 * 60 * 1000

/** Taken because of one step, so dailies must never push them out; each has its own rotation. */
const SAFETY_REASONS: BackupReason[] = ['manual', 'pre-migration', 'pre-purge', 'pre-restore']
const SAFETY_KEEP = 2

const REASONS: BackupReason[] = ['daily', ...SAFETY_REASONS]
const NAME_RE = /^vault-(\d{8})-(\d{6})-([a-z-]+)\.db$/
/** Files SQLite keeps next to a DB. Only the WAL carries data; `-shm` is rebuilt on open. */
const SIDECARS = ['-wal', '-shm']

export class BackupError extends Error {
  constructor(
    readonly code: 'disk' | 'invalid' | 'newer-schema' | 'missing',
    message: string,
  ) {
    super(message)
  }
}

export function backupKeepOf(db: DbHandle): number {
  const raw = getSetting(db, 'backupKeep')
  // Unset must mean the default, not Number(null) === 0 ("off").
  const v = raw == null ? NaN : Number(raw)
  return (BACKUP_KEEP_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_BACKUP_KEEP
}

/** `vault-20261027-031500-daily.db` — UTC, so names sort by time and never collide across DST. */
export function backupName(at: Date, reason: BackupReason): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const d = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}`
  const t = `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`
  return `vault-${d}-${t}-${reason}.db`
}

function parseName(name: string): { createdAt: number; reason: BackupReason } | null {
  const m = name.match(NAME_RE)
  if (!m || !REASONS.includes(m[3] as BackupReason)) return null
  const [y, mo, d] = [m[1].slice(0, 4), m[1].slice(4, 6), m[1].slice(6, 8)].map(Number)
  const [h, mi, s] = [m[2].slice(0, 2), m[2].slice(2, 4), m[2].slice(4, 6)].map(Number)
  return { createdAt: Date.UTC(y, mo - 1, d, h, mi, s), reason: m[3] as BackupReason }
}

/** Accepts only a bare backup file name, never a path (IPC input). */
export function isBackupName(name: unknown): name is string {
  return typeof name === 'string' && parseName(name) != null
}

/** Newest first. Unrelated files and half-written `.tmp` snapshots are ignored. */
export function listBackups(dir: string): BackupFile[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: BackupFile[] = []
  for (const name of names) {
    const meta = parseName(name)
    if (!meta) continue
    try {
      out.push({ name, ...meta, sizeBytes: fs.statSync(path.join(dir, name)).size })
    } catch {
      /* deleted while listing */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name))
}

function freeBytes(dir: string): number {
  try {
    const s = fs.statfsSync(dir)
    return s.bavail * s.bsize
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** A unique name even when two snapshots land in the same second. */
function freshName(dir: string, at: Date, reason: BackupReason): string {
  let ms = at.getTime()
  let name = backupName(new Date(ms), reason)
  while (fs.existsSync(path.join(dir, name))) {
    ms += 1000
    name = backupName(new Date(ms), reason)
  }
  return name
}

/**
 * Consistent snapshot of a live DB (`VACUUM INTO` reads one transaction, so concurrent
 * writers on other connections are fine). Written to `.tmp` and renamed, so a crash
 * mid-copy never leaves something that looks like a backup.
 */
export function snapshot(db: DbHandle, dir: string, reason: BackupReason, now = new Date()): BackupFile {
  fs.mkdirSync(dir, { recursive: true })
  const dbBytes = fs.statSync(db.name).size
  if (freeBytes(dir) < dbBytes * 1.2) {
    throw new BackupError('disk', `not enough free space for a ${Math.round(dbBytes / 1e6)} MB snapshot`)
  }
  const name = freshName(dir, now, reason)
  const tmp = path.join(dir, `${name}.tmp`)
  fs.rmSync(tmp, { force: true })
  try {
    db.prepare(`VACUUM INTO ?`).run(tmp)
    fs.renameSync(tmp, path.join(dir, name))
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  return { name, createdAt: parseName(name)!.createdAt, reason, sizeBytes: fs.statSync(path.join(dir, name)).size }
}

/**
 * Copy of a DB that no connection has open (startup, before a migration): the file and
 * its WAL are copied as they are. On APFS/Btrfs/ReFS this is a clone and costs nothing.
 */
export function copyClosedDb(dbFile: string, dir: string, reason: BackupReason, now = new Date()): BackupFile {
  fs.mkdirSync(dir, { recursive: true })
  const name = freshName(dir, now, reason)
  const dest = path.join(dir, name)
  try {
    if (fs.existsSync(`${dbFile}-wal`)) fs.copyFileSync(`${dbFile}-wal`, `${dest}-wal`, fs.constants.COPYFILE_FICLONE)
    fs.copyFileSync(dbFile, `${dest}.tmp`, fs.constants.COPYFILE_FICLONE)
    fs.renameSync(`${dest}.tmp`, dest)
  } catch (err) {
    // On a full disk the retry needs the space a partial copy would hold on to.
    for (const partial of [`${dest}.tmp`, `${dest}-wal`]) fs.rmSync(partial, { force: true })
    throw err
  }
  return { name, createdAt: parseName(name)!.createdAt, reason, sizeBytes: fs.statSync(dest).size }
}

/** Puts a copy of `source` (and its WAL, if any) at `dbFile`, replacing whatever is there. */
function installCopy(source: string, dbFile: string) {
  for (const suffix of SIDECARS) fs.rmSync(dbFile + suffix, { force: true })
  if (fs.existsSync(`${source}-wal`)) fs.copyFileSync(`${source}-wal`, `${dbFile}-wal`, fs.constants.COPYFILE_FICLONE)
  fs.copyFileSync(source, `${dbFile}.restoring`, fs.constants.COPYFILE_FICLONE)
  fs.renameSync(`${dbFile}.restoring`, dbFile)
}

function removeBackup(dir: string, name: string) {
  for (const suffix of ['', ...SIDECARS]) fs.rmSync(path.join(dir, name + suffix), { force: true })
}

/**
 * Keeps the newest `keep` dailies and the latest `SAFETY_KEEP` of each other reason;
 * returns the names removed. `keep` 0 removes nothing.
 */
export function pruneBackups(dir: string, keep: number): string[] {
  if (keep <= 0) return []
  const all = listBackups(dir)
  const ofReason = (reason: BackupReason) => all.filter((b) => b.reason === reason)
  const surplus = [
    ...ofReason('daily').slice(keep),
    ...SAFETY_REASONS.flatMap((reason) => ofReason(reason).slice(SAFETY_KEEP)),
  ]
  for (const b of surplus) removeBackup(dir, b.name)
  return surplus.map((b) => b.name)
}

export function dailyBackupDue(dir: string, keep: number, now = Date.now()): boolean {
  if (keep <= 0) return false
  const newest = listBackups(dir)[0]
  return !newest || now - newest.createdAt >= DAILY_MS
}

/**
 * Runs `read` on a read-only connection and leaves the folder as it found it: opening a
 * WAL-mode file, even read-only, creates empty -wal/-shm next to it, so the ones this
 * open created are removed. Only for a file no other connection has open.
 */
function readClosedDb<T>(file: string, read: (db: DbHandle) => T): T {
  const created = SIDECARS.filter((s) => !fs.existsSync(file + s))
  let db: DbHandle | null = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    return read(db)
  } finally {
    db?.close()
    for (const s of created) fs.rmSync(file + s, { force: true })
  }
}

/** Opens a backup read-only and checks it is a vault DB this build can open. */
export function verifyBackup(file: string): void {
  if (!fs.existsSync(file)) throw new BackupError('missing', `backup not found: ${path.basename(file)}`)
  try {
    readClosedDb(file, (db) => {
      const check = db.pragma('quick_check', { simple: true })
      if (check !== 'ok') throw new BackupError('invalid', `integrity check failed: ${String(check)}`)
      const v = readSchemaVersion(db)
      if (v === 0) throw new BackupError('invalid', 'not a vault database')
      if (v > SCHEMA_VERSION) throw new BackupError('newer-schema', `backup is schema v${v}; this build reads up to v${SCHEMA_VERSION}`)
    })
  } catch (err) {
    if (err instanceof BackupError) throw err
    throw new BackupError('invalid', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Swaps a backup in for the live DB. Every connection to `dbFile` must be closed. The
 * current DB is not deleted: it is moved into the backup folder as a `pre-restore`
 * snapshot (a rename, so it costs no disk and the restore can itself be undone).
 */
export function restoreBackup(dbFile: string, dir: string, name: string, now = new Date()): BackupFile | null {
  const source = path.join(dir, name)
  verifyBackup(source)
  let previous: BackupFile | null = null
  if (fs.existsSync(dbFile)) {
    const prevName = freshName(dir, now, 'pre-restore')
    for (const suffix of SIDECARS) {
      if (fs.existsSync(dbFile + suffix)) fs.renameSync(dbFile + suffix, path.join(dir, prevName + suffix))
    }
    fs.renameSync(dbFile, path.join(dir, prevName))
    previous = listBackups(dir).find((b) => b.name === prevName) ?? null
  }
  installCopy(source, dbFile)
  return previous
}

export type OpenOutcome =
  | { kind: 'ok' }
  | { kind: 'recovered'; from: string; quarantined: string }
  | { kind: 'rebuilt'; quarantined: string }

/** The DB was not opened, and the file on disk is the one that was there before. */
export type OpenRefusal =
  | { kind: 'retryable'; code: string }
  | { kind: 'newer-build'; version: number; known: number }

export type OpenResult = { db: DbHandle; outcome: OpenOutcome } | { db: null; outcome: OpenRefusal }

export type RetryCause = 'busy' | 'full' | 'denied' | 'other'

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'UNKNOWN'
}

/** The only errors that say the file itself is damaged. SQLite reports extended codes too. */
function isCorruption(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT_')
}

/** What the user can do about a retryable failure, from its SQLite or file system code. */
export function retryCause(code: string): RetryCause {
  if (/^(SQLITE_BUSY|SQLITE_LOCKED|EBUSY)/.test(code)) return 'busy'
  if (/^(SQLITE_FULL|ENOSPC|EDQUOT)/.test(code)) return 'full'
  if (/^(SQLITE_READONLY|SQLITE_CANTOPEN|SQLITE_PERM|EACCES|EPERM|EROFS)/.test(code)) return 'denied'
  return 'other'
}

function retryable(err: unknown): { db: null; outcome: OpenRefusal } {
  console.error('[vault] cannot open the database right now:', err)
  return { db: null, outcome: { kind: 'retryable', code: errorCode(err) } }
}

function newerBuild(version: number): { db: null; outcome: OpenRefusal } {
  return { db: null, outcome: { kind: 'newer-build', version, known: SCHEMA_VERSION } }
}

/**
 * Moves a DB and its sidecars aside, all or nothing: a stale WAL left next to the DB that
 * replaces this one would be replayed into it. A failed rename puts back what had moved.
 */
function quarantine(dbFile: string, now: Date): { target: string } | { error: unknown } {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const target = `${dbFile}.corrupt-${stamp}`
  const moved: string[] = []
  try {
    for (const suffix of ['', ...SIDECARS]) {
      if (!fs.existsSync(dbFile + suffix)) continue
      fs.renameSync(dbFile + suffix, target + suffix)
      moved.push(suffix)
    }
    return { target }
  } catch (error) {
    unquarantine(dbFile, target, moved)
    return { error }
  }
}

function unquarantine(dbFile: string, target: string, suffixes: string[]) {
  for (const suffix of suffixes) {
    try {
      fs.renameSync(target + suffix, dbFile + suffix)
    } catch (err) {
      console.error(`[vault] could not move ${target + suffix} back:`, err)
    }
  }
}

/** Removes what `installCopy` or a failed open left at `dbFile`; the original is in quarantine. */
function removeInstalled(dbFile: string) {
  for (const suffix of ['', ...SIDECARS, '.restoring']) fs.rmSync(dbFile + suffix, { force: true })
}

/**
 * Replaces a corrupt DB with the newest backup that opens, or an empty DB when none does.
 * A failure that is not about the backup (a full disk, say) puts the corrupt file back, so
 * the next attempt starts over instead of finding no DB and creating an empty one.
 */
function recover(dbFile: string, dir: string, now: Date, open: (file: string) => DbHandle): OpenResult {
  const moved = quarantine(dbFile, now)
  if ('error' in moved) return retryable(moved.error)
  const quarantined = moved.target
  const giveUp = (err: unknown) => {
    removeInstalled(dbFile)
    unquarantine(dbFile, quarantined, ['', ...SIDECARS].filter((s) => fs.existsSync(quarantined + s)))
    return retryable(err)
  }
  for (const b of listBackups(dir)) {
    const file = path.join(dir, b.name)
    try {
      verifyBackup(file)
    } catch (err) {
      console.error(`[vault] backup ${b.name} unusable:`, err)
      continue
    }
    try {
      installCopy(file, dbFile)
      return { db: open(dbFile), outcome: { kind: 'recovered', from: b.name, quarantined } }
    } catch (err) {
      if (!isCorruption(err)) return giveUp(err)
      console.error(`[vault] backup ${b.name} unusable:`, err)
      removeInstalled(dbFile)
    }
  }
  try {
    return { db: open(dbFile), outcome: { kind: 'rebuilt', quarantined } }
  } catch (err) {
    return giveUp(err)
  }
}

/** Schema version and backup setting of a DB without migrating it; null when unreadable. */
function peek(dbFile: string): { version: number; keep: number } | null {
  try {
    return readClosedDb(dbFile, (db) => ({ version: readSchemaVersion(db), keep: backupKeepOf(db) }))
  } catch {
    return null
  }
}

/**
 * Opens (and migrates) the vault DB at startup.
 * - A DB from a newer build is refused untouched.
 * - Before a schema migration, the old file is copied to the backup folder. A migration
 *   never runs without that copy (unless backups are off).
 * - Only a DB that is actually damaged (`SQLITE_CORRUPT`, `SQLITE_NOTADB`) is quarantined
 *   (kept on disk), and the newest backup that opens takes its place; only when none does
 *   is an empty DB created for a fresh index. A locked file, a full disk or a read-only
 *   folder says nothing about the DB, so those return `retryable` and swap nothing.
 */
export function openVaultDbWithRecovery(
  dbFile: string,
  dir: string,
  now = new Date(),
  open: (file: string) => DbHandle = openVaultDb,
): OpenResult {
  if (fs.existsSync(dbFile)) {
    const info = peek(dbFile)
    if (info && info.version > SCHEMA_VERSION) return newerBuild(info.version)
    if (info && info.version > 0 && info.version < SCHEMA_VERSION && info.keep > 0) {
      try {
        copyClosedDb(dbFile, dir, 'pre-migration', now)
      } catch (err) {
        return retryable(err)
      }
      try {
        pruneBackups(dir, info.keep)
      } catch (err) {
        console.error('[vault] could not prune old backups:', err)
      }
    }
  }
  try {
    return { db: open(dbFile), outcome: { kind: 'ok' } }
  } catch (err) {
    if (err instanceof NewerSchemaError) return newerBuild(err.version)
    if (!isCorruption(err)) return retryable(err)
    console.error('[vault] database is damaged:', err)
  }
  return recover(dbFile, dir, now, open)
}

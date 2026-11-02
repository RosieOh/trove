import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  getSetting,
  NewerSchemaError,
  openVaultDb,
  pendingMigrations,
  readSchemaVersion,
  SCHEMA_VERSION,
  tableExists,
  unknownVersion,
  type DbHandle,
} from './db.js'
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
    for (const s of created) {
      try {
        fs.rmSync(file + s, { force: true })
      } catch (err) {
        // An empty sidecar does no harm; throwing here would replace what `read` returned.
        console.error(`[vault] could not remove ${file + s}:`, err)
      }
    }
  }
}

/** Opens a backup read-only and checks it is a vault DB this build can open. */
export function verifyBackup(file: string): void {
  if (!fs.existsSync(file)) throw new BackupError('missing', `backup not found: ${path.basename(file)}`)
  try {
    readClosedDb(file, (db) => {
      const check = db.pragma('quick_check', { simple: true })
      if (check !== 'ok') throw new BackupError('invalid', `integrity check failed: ${String(check)}`)
      if (readSchemaVersion(db) === 0) throw new BackupError('invalid', 'not a vault database')
      const newer = unknownVersion(db)
      if (newer != null) throw new BackupError('newer-schema', `backup has schema v${newer}; this build reads up to v${SCHEMA_VERSION}`)
    })
  } catch (err) {
    if (err instanceof BackupError) throw err
    throw new BackupError('invalid', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Moves a DB and its sidecars to `target`, all or nothing: a stale WAL left next to the DB
 * that replaces this one would be replayed into it. The DB goes last, so a crash part way
 * never leaves a WAL with no DB. A failed rename puts back what had moved. Returns the
 * suffixes it moved.
 */
function moveDb(dbFile: string, target: string): string[] {
  const moved: string[] = []
  try {
    for (const suffix of [...SIDECARS, '']) {
      if (!fs.existsSync(dbFile + suffix)) continue
      fs.renameSync(dbFile + suffix, target + suffix)
      moved.push(suffix)
    }
    return moved
  } catch (err) {
    moveDbBack(dbFile, target, moved)
    throw err
  }
}

function moveDbBack(dbFile: string, target: string, suffixes: string[]) {
  for (const suffix of suffixes) {
    try {
      fs.renameSync(target + suffix, dbFile + suffix)
    } catch (err) {
      console.error(`[vault] could not move ${target + suffix} back:`, err)
    }
  }
}

/** Removes what `installCopy` or a failed open left at `dbFile`; the DB it replaced is elsewhere. */
function removeInstalled(dbFile: string) {
  for (const suffix of ['', ...SIDECARS, '.restoring']) {
    try {
      fs.rmSync(dbFile + suffix, { force: true })
    } catch (err) {
      console.error(`[vault] could not remove ${dbFile + suffix}:`, err)
    }
  }
}

/**
 * Swaps a backup in for the live DB. Every connection to `dbFile` must be closed. The
 * current DB is not deleted: it is moved into the backup folder as a `pre-restore`
 * snapshot (a rename, so it costs no disk and the restore can itself be undone). When the
 * copy cannot be installed the DB moves back, and if even that fails the next launch finds
 * the snapshot (see `openVaultDbWithRecovery`).
 */
export function restoreBackup(dbFile: string, dir: string, name: string, now = new Date()): BackupFile | null {
  const source = path.join(dir, name)
  verifyBackup(source)
  const prevName = freshName(dir, now, 'pre-restore')
  const target = path.join(dir, prevName)
  const moved = moveDb(dbFile, target)
  try {
    installCopy(source, dbFile)
  } catch (err) {
    removeInstalled(dbFile)
    moveDbBack(dbFile, target, moved)
    throw err
  }
  return listBackups(dir).find((b) => b.name === prevName) ?? null
}

export type OpenOutcome =
  | { kind: 'ok' }
  // `quarantined` is null when the DB was simply gone, so nothing had to be set aside.
  | { kind: 'recovered'; from: string; quarantined: string | null }
  | { kind: 'rebuilt'; quarantined: string | null }

/**
 * The DB was not opened, and the file on disk is the one that was there before. `path` is
 * what could not be used, which is the backup folder when the pre-migration copy failed.
 */
export type OpenRefusal =
  | { kind: 'retryable'; code: string; path: string }
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

function retryable(err: unknown, where: string): { db: null; outcome: OpenRefusal } {
  console.error('[vault] cannot open the database right now:', err)
  return { db: null, outcome: { kind: 'retryable', code: errorCode(err), path: where } }
}

function newerBuild(version: number): { db: null; outcome: OpenRefusal } {
  return { db: null, outcome: { kind: 'newer-build', version, known: SCHEMA_VERSION } }
}

/**
 * Puts the newest backup that opens at `dbFile`, or an empty DB when none does. `dbFile` is
 * free by now, and `quarantined` is the file that was set aside, if any.
 */
function installNewestBackup(dbFile: string, dir: string, quarantined: string | null, open: (file: string) => DbHandle): OpenResult {
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
      removeInstalled(dbFile)
      if (!isCorruption(err)) return retryable(err, dbFile)
      console.error(`[vault] backup ${b.name} unusable:`, err)
    }
  }
  try {
    return { db: open(dbFile), outcome: { kind: 'rebuilt', quarantined } }
  } catch (err) {
    removeInstalled(dbFile)
    return retryable(err, dbFile)
  }
}

/**
 * Quarantines a corrupt DB and puts a backup or an empty DB in its place. A failure that is
 * not about the backup (a full disk, say) puts the corrupt file back, so the next attempt
 * starts over.
 */
function recover(dbFile: string, dir: string, now: Date, open: (file: string) => DbHandle): OpenResult {
  const target = `${dbFile}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
  let moved: string[]
  try {
    moved = moveDb(dbFile, target)
  } catch (err) {
    return retryable(err, dbFile)
  }
  const result = installNewestBackup(dbFile, dir, target, open)
  if (!result.db) moveDbBack(dbFile, target, moved)
  return result
}

/** The most recently quarantined DB next to `dbFile`, if any. The stamps in the names sort by time. */
function newestQuarantined(dbFile: string): string | null {
  const folder = path.dirname(dbFile)
  const prefix = `${path.basename(dbFile)}.corrupt-`
  let names: string[] = []
  try {
    names = fs.readdirSync(folder)
  } catch {
    return null
  }
  const newest = names.filter((n) => n.startsWith(prefix) && !SIDECARS.some((s) => n.endsWith(s))).sort().at(-1)
  return newest ? path.join(folder, newest) : null
}

type DbInfo = { newer: number | null; pending: boolean; keep: number; empty: boolean }

/** What a DB holds, without migrating it. A failed read is returned for the caller to judge. */
function peek(dbFile: string): DbInfo | { error: unknown } {
  try {
    return readClosedDb(dbFile, (db) => ({
      newer: unknownVersion(db),
      pending: pendingMigrations(db).length > 0,
      keep: tableExists(db, 'meta') ? backupKeepOf(db) : DEFAULT_BACKUP_KEEP,
      empty: !db.prepare(`SELECT 1 FROM sqlite_master LIMIT 1`).get(),
    }))
  } catch (error) {
    return { error }
  }
}

/**
 * Opens (and migrates) the vault DB at startup.
 * - A DB from a newer build (a version above this build's, or a migration id it does not
 *   know) is refused untouched.
 * - With any migration pending, the old file is first copied to the backup folder. A
 *   migration never runs without that copy (unless backups are off), so a DB whose state
 *   cannot be read is not opened at all.
 * - Only a DB that is actually damaged (`SQLITE_CORRUPT`, `SQLITE_NOTADB`) is quarantined
 *   (kept on disk), and the newest backup that opens takes its place; only when none does
 *   is an empty DB created for a fresh index. A locked file, a full disk or a read-only
 *   file or folder says nothing about the DB, so those return `retryable` and swap nothing.
 * - No DB is a first launch only when nothing says there was one. With a backup or a
 *   quarantined file around, the DB went missing (a restore or a recovery that stopped part
 *   way, say), and an empty DB would hide the archive and let dailies rotate out good copies.
 */
export function openVaultDbWithRecovery(
  dbFile: string,
  dir: string,
  now = new Date(),
  open: (file: string) => DbHandle = openVaultDb,
): OpenResult {
  if (fs.existsSync(dbFile)) {
    const info = peek(dbFile)
    if ('error' in info) {
      if (!isCorruption(info.error)) return retryable(info.error, dbFile)
      console.error('[vault] database is damaged:', info.error)
      return recover(dbFile, dir, now, open)
    }
    if (info.newer != null) return newerBuild(info.newer)
    // Asked before SQLite gets the file: it would open it read-only regardless and leave
    // sidecars with the file's mode, which would fail the retry after the user fixes the DB.
    for (const suffix of ['', ...SIDECARS]) {
      try {
        if (fs.existsSync(dbFile + suffix)) fs.accessSync(dbFile + suffix, fs.constants.W_OK)
      } catch (err) {
        return retryable(err, dbFile + suffix)
      }
    }
    if (info.pending && !info.empty && info.keep > 0) {
      try {
        copyClosedDb(dbFile, dir, 'pre-migration', now)
      } catch (err) {
        return retryable(err, dir)
      }
      try {
        pruneBackups(dir, info.keep)
      } catch (err) {
        console.error('[vault] could not prune old backups:', err)
      }
    }
  } else {
    const quarantined = newestQuarantined(dbFile)
    if (quarantined || listBackups(dir).length > 0) return installNewestBackup(dbFile, dir, quarantined, open)
  }
  try {
    return { db: open(dbFile), outcome: { kind: 'ok' } }
  } catch (err) {
    if (err instanceof NewerSchemaError) return newerBuild(err.version)
    if (!isCorruption(err)) return retryable(err, dbFile)
    console.error('[vault] database is damaged:', err)
  }
  return recover(dbFile, dir, now, open)
}

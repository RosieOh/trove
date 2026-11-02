import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { getSetting, setSetting, type DbHandle } from './db.js'
import {
  BackupError,
  backupKeepOf,
  dailyBackupDue,
  isBackupName,
  listBackups,
  openVaultDbWithRecovery,
  pruneBackups,
  restoreBackup,
  retryCause,
  verifyBackup,
  type OpenOutcome,
  type OpenResult,
} from './backup.js'
import { claudeHomeDir, defaultClaudePlansRoot } from './claudeRoots.js'
import { allAdapters } from './adapters.js'
import { archiveModeOf } from './indexer.js'
import { BackupFailed, IndexService } from './indexService.js'
import { migrateLegacyUserData } from './userDataMigration.js'
import { QueryService } from './queryService.js'
import { checkForUpdates, getUpdateStatus, initAutoUpdate, installUpdate, setAutoUpdateEnabled } from './updater.js'
import { listPrices, resetPrices, savePrices } from './prices.js'
import { EMPTY_STATS } from './stats.js'
import {
  addFavorite,
  createTag,
  deleteTag,
  listFavorites,
  listProjects,
  listTags,
  messageBody,
  purgeArchived,
  recordAppOpen,
  recentSessions,
  removeFavorite,
  renameTag,
  sessionInfo,
  setMessageTags,
} from './queries.js'
import { DEFAULT_BACKUP_KEEP, IPC } from '../shared/ipc.js'
import { localDay } from '../shared/appOpens.js'
import type {
  BackupInfo,
  BackupReason,
  BackupResult,
  ExportSaveResult,
  FileRow,
  FileTouchRow,
  IndexProgress,
  PlanListRow,
  PromptRow,
  ReindexResult,
  RestoreResult,
  SessionMessageRow,
  Settings,
  SettingsInfo,
  StatsPayload,
  TemplateRow,
  UnifiedSearchHit,
} from '../shared/ipc.js'
import type { WatchEventKind } from './workerProtocol.js'
import {
  sanitizeClipboardText,
  sanitizeExportFormat,
  sanitizeExportMessageIds,
  sanitizeFilePath,
  sanitizeFileQuery,
  sanitizeExportOptions,
  sanitizeMessageId,
  sanitizeMsgKey,
  sanitizePlanId,
  sanitizePromptQuery,
  sanitizeSearchFilters,
  sanitizeSessionId,
  sanitizeSettingsPatch,
  sanitizeTagColor,
  sanitizeTagIds,
  sanitizeTagName,
  sanitizeTemplateBody,
  sanitizeTemplateId,
  sanitizePrices,
  sanitizeTemplateName,
} from './ipcGuards.js'

// The Electron main bundle is emitted as CommonJS (dist-electron/main.cjs), so
// __dirname is provided by Node's module wrapper — no import.meta.url shim needed.
declare const __dirname: string

// Test/dev override: keep the vault DB somewhere disposable instead of the real profile.
const userDataOverride = process.env.VAULT_USER_DATA?.trim()
if (userDataOverride && path.isAbsolute(userDataOverride)) app.setPath('userData', userDataOverride)
else {
  // Before anything opens the folder (single-instance lock, Chromium, the DB).
  try {
    const from = migrateLegacyUserData(app.getPath('appData'), app.getPath('userData'))
    if (from) console.info(`[vault] moved user data from ${from}`)
  } catch (err) {
    console.error('[vault] could not move user data from the old app name:', err)
  }
}

/** Product name shown in window and dialog titles (package.json `productName`). */
const APP_NAME = 'Trove'

let mainWindow: BrowserWindow | null = null
let db: DbHandle | null = null
let indexService: IndexService | null = null
let queryService: QueryService | null = null
let plansRoot = ''

function vaultDbPath(): string {
  return path.join(app.getPath('userData'), 'vault.db')
}

function backupsDir(): string {
  return path.join(app.getPath('userData'), 'backups')
}

/** The window, unless it has been closed: on macOS the app and its workers outlive it. */
function liveWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function sendToRenderer(channel: string, ...args: unknown[]) {
  const win = liveWindow()
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
}

function broadcastIndexUpdated() {
  sendToRenderer(IPC.onIndexUpdated)
}

function broadcastIndexProgress(p: IndexProgress) {
  sendToRenderer(IPC.onIndexProgress, p)
}

/**
 * The renderer displays text harvested from log files we do not control, so it
 * is treated as untrusted: links may only leave the app through the OS browser,
 * and the window itself must never navigate away from the app bundle.
 */
function applyNavigationPolicy(win: BrowserWindow) {
  const devOrigin = process.env.VITE_DEV_SERVER_URL

  const openExternally = (url: string) => {
    // Only ever hand well-known web schemes to the OS; file:/ javascript: etc. are dropped.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const sameApp = devOrigin ? url.startsWith(devOrigin) : url.startsWith('file://')
    if (!sameApp) {
      event.preventDefault()
      openExternally(url)
    }
  })

  // Nothing in this app needs a webview, permissions, or remote content.
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    backgroundColor: '#fafafb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only touches contextBridge/ipcRenderer, so the renderer can
      // run fully sandboxed.
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  applyNavigationPolicy(mainWindow)

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // DevTools는 Electron/Chromium 버전 차이로 콘솔에 무해한 오류가 잔뜩 찍힐 수 있어 기본은 끕니다.
    // 필요 시: VAULT_OPEN_DEVTOOLS=1 npm run dev
    if (process.env.VAULT_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function readSettings(): Settings {
  return {
    archiveMode: db ? archiveModeOf(db) : 'keep',
    autoUpdate: db ? getSetting(db, 'autoUpdate') !== 'off' : true,
    backupKeep: db ? backupKeepOf(db) : DEFAULT_BACKUP_KEEP,
  }
}

let lastOpenDay = ''
/**
 * Marks today as a day the app was used (launch, or focus on a later day: the window
 * often stays open for days). Only the local date is stored, for the Stats tab.
 */
function noteAppOpen() {
  const day = localDay(new Date())
  if (!db || day === lastOpenDay) return
  lastOpenDay = day
  try {
    recordAppOpen(db, day)
  } catch (err) {
    console.error('[vault] could not record app open:', err)
  }
}

let backupChain: Promise<unknown> = Promise.resolve()

/**
 * Snapshot on the index worker (VACUUM INTO of ~1 GB would block the main thread for
 * seconds), then prune to the configured count. Serialized so a manual click during
 * the daily run cannot start a second copy.
 */
function runBackup(reason: BackupReason): Promise<BackupResult> {
  const job = backupChain.then(async (): Promise<BackupResult> => {
    if (!indexService || !db) return { ok: false, error: 'failed', message: 'not ready' }
    try {
      const file = await indexService.backup(backupsDir(), reason)
      // With backups off (0), a manual snapshot is extra: never prune the existing ones.
      pruneBackups(backupsDir(), backupKeepOf(db))
      return { ok: true, file }
    } catch (err) {
      const error = err instanceof BackupFailed && err.code === 'disk' ? 'disk' : 'failed'
      console.error(`[vault] ${reason} backup failed:`, err)
      return { ok: false, error, message: err instanceof Error ? err.message : String(err) }
    }
  })
  backupChain = job
  return job
}

/** Once after the first scan, then hourly: take the daily snapshot when one is due. */
function scheduleDailyBackups() {
  const check = () => {
    if (db && dailyBackupDue(backupsDir(), backupKeepOf(db))) void runBackup('daily')
  }
  check()
  setInterval(check, 60 * 60 * 1000).unref()
}

function backupInfo(): BackupInfo {
  const items = listBackups(backupsDir())
  return {
    dir: backupsDir(),
    keep: db ? backupKeepOf(db) : DEFAULT_BACKUP_KEEP,
    items,
    totalBytes: items.reduce((n, b) => n + b.sizeBytes, 0),
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

/** Never write under ~/.claude — not even an export the user points there by accident. */
function isInsideClaudeHome(target: string): boolean {
  const rel = path.relative(claudeHomeDir(), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function registerIpc() {
  const query = <T>(method: string, ...args: unknown[]) => queryService!.call<T>(method, ...args)

  ipcMain.handle(IPC.projectsList, async () => (db ? listProjects(db) : []))

  // `null` = superseded by a newer search while waiting (see QueryService.search).
  ipcMain.handle(IPC.search, async (_e, raw: unknown) =>
    db ? queryService!.search<UnifiedSearchHit[]>(sanitizeSearchFilters(raw)) : [],
  )

  ipcMain.handle(IPC.plansList, async (): Promise<PlanListRow[]> => {
    if (!db) return []
    const rows = db
      .prepare(
        `SELECT id, file_path AS filePath, title, file_mtime_ms AS mtime, archived_at IS NOT NULL AS archived
         FROM plan_files
         ORDER BY file_mtime_ms DESC
         LIMIT 40`,
      )
      .all() as (Omit<PlanListRow, 'archived'> & { archived: number })[]
    return rows.map((r) => ({ ...r, archived: r.archived === 1 }))
  })

  ipcMain.handle(IPC.planBody, async (_e, raw: unknown) => {
    if (!db) return ''
    const planId = sanitizePlanId(raw)
    if (planId == null) return ''
    const row = db.prepare(`SELECT body FROM plan_files WHERE id = ?`).get(planId) as { body: string } | undefined
    return row?.body ?? ''
  })

  ipcMain.handle(IPC.sessionTranscript, async (_e, raw: unknown) => {
    const sessionId = sanitizeSessionId(raw)
    if (!db || sessionId == null) return []
    return query<SessionMessageRow[]>('transcript', sessionId)
  })

  ipcMain.handle(IPC.sessionInfo, async (_e, raw: unknown) => {
    const sessionId = sanitizeSessionId(raw)
    return db && sessionId != null ? sessionInfo(db, sessionId) : null
  })

  ipcMain.handle(IPC.messageBody, async (_e, raw: unknown) => {
    const id = sanitizeMessageId(raw)
    return db && id != null ? messageBody(db, id) : ''
  })

  ipcMain.handle(IPC.recentSessions, async (_e, raw: unknown) =>
    db ? recentSessions(db, sanitizeSessionId(raw)) : [],
  )

  ipcMain.handle(IPC.promptsList, async (_e, raw: unknown) =>
    db ? query<PromptRow[]>('prompts', sanitizePromptQuery(raw)) : [],
  )

  ipcMain.handle(IPC.pricesList, async () => (db ? listPrices(db) : []))

  ipcMain.handle(IPC.pricesSave, async (_e, raw: unknown) => {
    if (!db) return []
    return savePrices(db, sanitizePrices(raw))
  })

  ipcMain.handle(IPC.pricesReset, async () => (db ? resetPrices(db) : []))

  ipcMain.handle(IPC.templatesList, async () => {
    if (!db) return []
    return db
      .prepare(
        `SELECT id, name, body, created_at AS createdAt, updated_at AS updatedAt
         FROM templates ORDER BY updated_at DESC`,
      )
      .all() as TemplateRow[]
  })

  ipcMain.handle(IPC.templateCreate, async (_e, rawName: unknown, rawBody: unknown) => {
    if (!db) return 0
    const name = sanitizeTemplateName(rawName)
    const body = sanitizeTemplateBody(rawBody)
    const now = Date.now()
    const r = db
      .prepare(`INSERT INTO templates (name, body, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(name, body, now, now)
    return Number(r.lastInsertRowid)
  })

  ipcMain.handle(IPC.templateUpdate, async (_e, rawId: unknown, rawName: unknown, rawBody: unknown) => {
    if (!db) return
    const id = sanitizeTemplateId(rawId)
    if (id == null) return
    const name = sanitizeTemplateName(rawName)
    const body = sanitizeTemplateBody(rawBody)
    db.prepare(`UPDATE templates SET name = ?, body = ?, updated_at = ? WHERE id = ?`).run(
      name,
      body,
      Date.now(),
      id,
    )
  })

  ipcMain.handle(IPC.templateDelete, async (_e, rawId: unknown) => {
    if (!db) return
    const id = sanitizeTemplateId(rawId)
    if (id == null) return
    db.prepare(`DELETE FROM templates WHERE id = ?`).run(id)
  })

  ipcMain.handle(IPC.filesList, async (_e, raw: unknown) =>
    db ? query<FileRow[]>('filesList', sanitizeFileQuery(raw)) : [],
  )

  ipcMain.handle(IPC.fileTimeline, async (_e, raw: unknown) => {
    const p = sanitizeFilePath(raw)
    if (!db || !p) return []
    return query<FileTouchRow[]>('fileTimeline', p)
  })

  ipcMain.handle(IPC.updateStatus, async () => getUpdateStatus())
  ipcMain.handle(IPC.updateCheck, async () => checkForUpdates())
  ipcMain.handle(IPC.updateInstall, async () => installUpdate())

  ipcMain.handle(IPC.reindex, async (_e, rawReparse: unknown): Promise<ReindexResult> => {
    if (!indexService) return { projects: 0, sessions: 0, planFiles: 0 }
    return indexService.scan(rawReparse === true)
  })

  ipcMain.handle(IPC.copyText, async (_e, raw: unknown) => {
    clipboard.writeText(sanitizeClipboardText(raw))
  })

  ipcMain.handle(IPC.favoritesList, async () => (db ? listFavorites(db) : []))

  ipcMain.handle(IPC.favoriteAdd, async (_e, raw: unknown) => {
    const messageId = sanitizeMessageId(raw)
    if (db && messageId != null) addFavorite(db, messageId)
  })

  ipcMain.handle(IPC.favoriteRemove, async (_e, raw: unknown) => {
    const key = sanitizeMsgKey(raw)
    if (db && key) removeFavorite(db, key)
  })

  ipcMain.handle(IPC.tagsList, async () => (db ? listTags(db) : []))

  ipcMain.handle(IPC.tagCreate, async (_e, rawName: unknown, rawColor: unknown) => {
    const name = sanitizeTagName(rawName)
    if (!db || !name) return 0
    return createTag(db, name, sanitizeTagColor(rawColor))
  })

  ipcMain.handle(IPC.tagRename, async (_e, rawId: unknown, rawName: unknown) => {
    const id = sanitizeTemplateId(rawId)
    const name = sanitizeTagName(rawName)
    if (!db || id == null || !name) return false
    return renameTag(db, id, name)
  })

  ipcMain.handle(IPC.tagDelete, async (_e, rawId: unknown) => {
    const id = sanitizeTemplateId(rawId)
    if (db && id != null) deleteTag(db, id)
  })

  ipcMain.handle(IPC.messageTagsSet, async (_e, rawKey: unknown, rawTagIds: unknown) => {
    const key = sanitizeMsgKey(rawKey)
    if (db && key) setMessageTags(db, key, sanitizeTagIds(rawTagIds))
  })

  ipcMain.handle(IPC.stats, async () => (db ? query<StatsPayload>('stats') : EMPTY_STATS))

  ipcMain.handle(IPC.settingsGet, async (): Promise<SettingsInfo> => {
    const dbPath = vaultDbPath()
    return {
      ...readSettings(),
      dbPath,
      dbSizeBytes: fileSize(dbPath) + fileSize(`${dbPath}-wal`),
      claudeHome: claudeHomeDir(),
      archivedPlans: db
        ? (db.prepare(`SELECT COUNT(*) AS c FROM plan_files WHERE archived_at IS NOT NULL`).get() as { c: number }).c
        : 0,
    }
  })

  ipcMain.handle(IPC.settingsSet, async (_e, raw: unknown): Promise<Settings> => {
    const patch = sanitizeSettingsPatch(raw)
    if (db) {
      if (patch.archiveMode) setSetting(db, 'archiveMode', patch.archiveMode)
      if (patch.autoUpdate != null) {
        setSetting(db, 'autoUpdate', patch.autoUpdate ? 'on' : 'off')
        setAutoUpdateEnabled(patch.autoUpdate)
      }
      if (patch.backupKeep != null) {
        setSetting(db, 'backupKeep', String(patch.backupKeep))
        // Lowering the count applies right away; 0 stops new backups but deletes none.
        pruneBackups(backupsDir(), patch.backupKeep)
        if (dailyBackupDue(backupsDir(), patch.backupKeep)) void runBackup('daily')
      }
    }
    return readSettings()
  })

  ipcMain.handle(IPC.archivePurge, async () => {
    if (!db) return 0
    // Archived sessions exist nowhere else: never purge without a snapshot to undo it,
    // unless the user turned backups off.
    if (backupKeepOf(db) > 0) {
      const b = await runBackup('pre-purge')
      if (!b.ok) throw new Error(`backup-failed:${b.error}`)
    }
    const n = purgeArchived(db)
    broadcastIndexUpdated()
    return n
  })

  ipcMain.handle(IPC.backupsList, async (): Promise<BackupInfo> => backupInfo())

  ipcMain.handle(IPC.backupCreate, async (): Promise<BackupResult> => runBackup('manual'))

  ipcMain.handle(IPC.backupsReveal, async () => {
    fs.mkdirSync(backupsDir(), { recursive: true })
    await shell.openPath(backupsDir())
  })

  ipcMain.handle(IPC.backupRestore, async (_e, rawName: unknown): Promise<RestoreResult> => {
    if (!isBackupName(rawName)) return { ok: false, error: 'missing' }
    const name = rawName
    // Check the snapshot before anything is closed, so a bad file changes nothing.
    try {
      verifyBackup(path.join(backupsDir(), name))
    } catch (err) {
      const error = err instanceof BackupError && err.code !== 'disk' ? err.code : 'failed'
      return { ok: false, error, message: err instanceof Error ? err.message : String(err) }
    }
    await backupChain.catch(() => undefined)
    shuttingDown = true
    await closeAll()
    try {
      restoreBackup(vaultDbPath(), backupsDir(), name)
    } catch (err) {
      // Relaunch anyway: startup recovery opens whatever DB (or backup) is usable.
      console.error('[vault] restore failed:', err)
    }
    app.relaunch()
    app.exit(0)
    return { ok: false, error: 'failed', message: 'relaunching' }
  })

  ipcMain.handle(
    IPC.exportMessages,
    async (_e, rawIds: unknown, format: unknown, rawOpts?: unknown) => {
    if (!db) return ''
    const messageIds = sanitizeExportMessageIds(rawIds)
    if (!messageIds.length) return ''
    const fmt = sanitizeExportFormat(format)
    const opts = sanitizeExportOptions(rawOpts)
    const placeholders = messageIds.map(() => '?').join(',')
    let rows = db
      .prepare(
        `SELECT m.id, m.role, m.body, m.line_index, m.message_class AS messageClass, s.rel_path, p.slug
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
         WHERE m.id IN (${placeholders})
         ORDER BY m.id`,
      )
      .all(...messageIds) as {
        id: number
        role: string
        body: string
        line_index: number
        messageClass: string
        rel_path: string
        slug: string
      }[]

    const exM = opts?.excludeMeta !== false
    const exS = opts?.excludeSubagents === true
    if (exM) {
      rows = rows.filter((r) => r.messageClass !== 'meta')
    }
    if (exS) {
      rows = rows.filter((r) => !r.rel_path.includes('subagents'))
    }

    if (fmt === 'csv') {
      const header = 'id,project,session_file,line,role,body\n'
      const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
      const lines = rows.map((r) =>
        [r.id, r.slug, r.rel_path, r.line_index, r.role, esc(r.body)].join(','),
      )
      return header + lines.join('\n')
    }
    const parts = rows.map(
      (r) => `### ${r.slug} / ${r.rel_path} (line ${r.line_index}, ${r.role})\n\n${r.body}\n`,
    )
    return parts.join('\n---\n\n')
  })

  ipcMain.handle(IPC.exportSave, async (_e, rawText: unknown, rawFormat: unknown): Promise<ExportSaveResult> => {
    const text = String(rawText ?? '')
    if (!text) return { saved: false }
    const ext = sanitizeExportFormat(rawFormat)
    const stamp = new Date().toISOString().slice(0, 10)
    const opts = {
      defaultPath: path.join(app.getPath('documents'), `claude-vault-export-${stamp}.${ext}`),
      filters: [ext === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'Markdown', extensions: ['md'] }],
    }
    const win = liveWindow()
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { saved: false }
    if (isInsideClaudeHome(res.filePath)) {
      return { saved: false, error: 'claude-home' }
    }
    try {
      fs.writeFileSync(res.filePath, text, 'utf8')
      return { saved: true, path: res.filePath }
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/**
 * Content-Security-Policy applied to every response. The renderer never loads
 * remote code or makes network requests, so everything but same-origin assets is
 * denied. Vite's dev server needs inline/eval for HMR, so the dev policy is
 * loosened only for scripts while still blocking remote origins.
 */
function applyContentSecurityPolicy() {
  const dev = Boolean(process.env.VITE_DEV_SERVER_URL)
  const scriptSrc = dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'"
  const connectSrc = dev ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'none'"
  const policy = [
    "default-src 'none'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    connectSrc,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ')

  const { session } = mainWindow!.webContents
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

let watcher: FSWatcher | null = null

/**
 * Watch every source root (Claude projects, plans, other tools). chokidar v4 removed
 * glob support, so roots are watched directly and filtered by extension. A root that
 * does not exist yet (Claude Code not run yet, Codex not installed) is polled until it
 * appears — the app never creates directories under ~/.claude itself.
 */
function startWatcher() {
  const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__'])
  const roots = [...new Set([...allAdapters().map((a) => a.root), plansRoot])]
  watcher = chokidar.watch([], {
    ignoreInitial: true,
    ignored: (p: string) => p.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg)),
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })

  // Claude Code appends to the active session constantly; batch events per flush.
  const pending = new Map<string, WatchEventKind>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const enqueue = (p: string, kind: WatchEventKind) => {
    const np = path.normalize(p)
    const lower = np.toLowerCase()
    if (!lower.endsWith('.jsonl') && !lower.endsWith('.md')) return
    pending.set(np, kind)
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        const events = [...pending].map(([path, kind]) => ({ path, kind }))
        pending.clear()
        indexService?.notify(events)
      }, 300)
    }
  }
  watcher.on('add', (p) => enqueue(p, 'add'))
  watcher.on('change', (p) => enqueue(p, 'change'))
  watcher.on('unlink', (p) => enqueue(p, 'unlink'))

  const waiting = new Set<string>()
  for (const root of roots) {
    if (fs.existsSync(root)) watcher.add(root)
    else waiting.add(root)
  }
  if (waiting.size) {
    const poll = setInterval(() => {
      for (const root of [...waiting]) {
        if (!fs.existsSync(root)) continue
        waiting.delete(root)
        watcher?.add(root)
        void indexService?.scan().catch((err) => console.error('[vault] scan after root appeared failed', err))
      }
      if (!waiting.size) clearInterval(poll)
    }, 30_000)
  }
}

/**
 * Main-process dialogs can fire before any window exists, so they cannot reach
 * the renderer's locale. Fall back to the OS locale — the only signal available
 * this early.
 */
function mainLocale(): 'ko' | 'en' {
  return app.getLocale().toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

const MAIN_STRINGS = {
  ko: {
    fatal: '예기치 못한 오류가 생겼어요.',
    continue: '계속',
    retry: '다시 시도',
    quit: '끝내기',
    initialIndex: '초기 색인',
    recovered: '색인 DB를 열 수 없어서 백업으로 되돌렸어요.',
    recoveredDetail: '{from} 백업을 썼어요. 그 뒤 바뀐 대화는 ~/.claude에서 다시 색인해요.\n\n열리지 않은 파일은 지우지 않고 남겨 뒀어요:\n{file}',
    rebuilt: '색인 DB를 열 수 없어서 새로 만들었어요.',
    rebuiltDetail: '쓸 수 있는 백업이 없었어요. ~/.claude에서 다시 색인해요. 보관돼 있던 대화와 즐겨찾기·태그는 아래 파일에 남아 있어요:\n{file}',
    retryBusy: '다른 프로그램이 색인 DB를 쓰고 있어서 열지 못했어요.',
    retryFull: '디스크 공간이 부족해서 색인 DB를 열지 못했어요.',
    retryDenied: '이 폴더에 쓸 수 없어서 색인 DB를 열지 못했어요.',
    retryOther: '색인 DB를 지금은 열 수 없어요.',
    retryDetail: 'DB는 그대로 두었어요. 원인을 해결한 뒤 다시 시도해 주세요.\n\n{file}\n\n오류 코드: {code}',
    newerBuild: '이 색인 DB는 더 새로운 Trove에서 만들어졌어요.',
    newerBuildDetail: '이 버전은 스키마 v{known}까지만 읽을 수 있는데, DB는 v{version}이에요. DB는 건드리지 않았어요. 최신 Trove를 설치해 주세요.\n\n{file}',
    cannotWrite: '데이터 폴더에 쓸 수 없어서 Trove를 시작하지 못했어요.',
    cannotWriteDetail: '이 폴더의 쓰기 권한과 남은 디스크 공간을 확인한 뒤 다시 열어 주세요. 안의 파일은 바꾸지 않았어요.\n\n{file}\n\n오류 코드: {code}',
  },
  en: {
    fatal: 'Something went wrong.',
    continue: 'Continue',
    retry: 'Try again',
    quit: 'Quit',
    initialIndex: 'initial indexing',
    recovered: 'The index database could not be opened, so a backup was restored.',
    recoveredDetail: 'Restored from {from}. Conversations changed since then are re-indexed from ~/.claude.\n\nThe file that failed to open was kept:\n{file}',
    rebuilt: 'The index database could not be opened, so a new one was created.',
    rebuiltDetail: 'No usable backup was found. Everything is re-indexed from ~/.claude. Archived conversations, favorites and tags are still in this file:\n{file}',
    retryBusy: 'Another program is using the index database, so it could not be opened.',
    retryFull: 'There is not enough disk space to open the index database.',
    retryDenied: 'The index database could not be opened because this folder cannot be written to.',
    retryOther: 'The index database cannot be opened right now.',
    retryDetail: 'The database was left as it is. Fix the cause, then try again.\n\n{file}\n\nError code: {code}',
    newerBuild: 'This index database was made by a newer version of Trove.',
    newerBuildDetail: 'This version reads up to schema v{known}, and the database is v{version}. It was not touched. Please install the latest Trove.\n\n{file}',
    cannotWrite: 'Trove could not start because its data folder cannot be written to.',
    cannotWriteDetail: 'Check the write permission on this folder and the free disk space, then open Trove again. Nothing in it was changed.\n\n{file}\n\nError code: {code}',
  },
} as const

/** Fills `{name}` placeholders. Paths are arbitrary text, so `$` must stay literal. */
function fillText(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => String(values[name] ?? whole))
}

/** Tells the user when startup had to restore or rebuild the DB (it used to happen silently). */
function reportOpenOutcome(outcome: OpenOutcome) {
  const win = liveWindow()
  if (outcome.kind === 'ok' || !win) return
  const s = MAIN_STRINGS[mainLocale()]
  const values = { file: outcome.quarantined, from: outcome.kind === 'recovered' ? outcome.from : '' }
  void dialog.showMessageBox(win, {
    type: outcome.kind === 'recovered' ? 'info' : 'warning',
    title: APP_NAME,
    message: outcome.kind === 'recovered' ? s.recovered : s.rebuilt,
    detail: fillText(outcome.kind === 'recovered' ? s.recoveredDetail : s.rebuiltDetail, values),
    buttons: [s.continue],
  })
}

/**
 * Opens the vault DB, asking the user when it cannot be opened yet. These dialogs come
 * before any window: without the DB there is nothing a window could show. Null means quit.
 */
async function openVaultDbOrAsk(): Promise<Extract<OpenResult, { db: DbHandle }> | null> {
  for (;;) {
    const opened = openVaultDbWithRecovery(vaultDbPath(), backupsDir())
    if (opened.db) return opened
    const { outcome } = opened
    const s = MAIN_STRINGS[mainLocale()]
    if (outcome.kind === 'newer-build') {
      await dialog.showMessageBox({
        type: 'warning',
        title: APP_NAME,
        message: s.newerBuild,
        detail: fillText(s.newerBuildDetail, { known: outcome.known, version: outcome.version, file: vaultDbPath() }),
        buttons: [s.quit],
      })
      return null
    }
    const messages = { busy: s.retryBusy, full: s.retryFull, denied: s.retryDenied, other: s.retryOther }
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: messages[retryCause(outcome.code)],
      detail: fillText(s.retryDetail, { file: vaultDbPath(), code: outcome.code }),
      buttons: [s.retry, s.quit],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return null
  }
}

/** Dialogs already raised, so a failure that repeats (on every index update, say) raises one. */
const fatalShown = new Set<string>()

function reportFatal(scope: string, err: unknown): Promise<unknown> | undefined {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[vault] ${scope}:`, message)
  const key = `${scope}\n${message}`
  if (!app.isReady() || fatalShown.has(key)) return undefined
  fatalShown.add(key)
  const s = MAIN_STRINGS[mainLocale()]
  return dialog.showMessageBox({
    type: 'error',
    title: APP_NAME,
    message: s.fatal,
    detail: `${scope}\n\n${message.slice(0, 1500)}`,
    buttons: [s.continue],
  })
}

// A background indexing failure must not take the whole app down.
process.on('uncaughtException', (err) => void reportFatal('uncaughtException', err))
process.on('unhandledRejection', (err) => void reportFatal('unhandledRejection', err))

/** Why the data folder cannot be written, or null if it can. Writes, as access(2) misses a full disk. */
function userDataWriteError(): string | null {
  const probe = path.join(app.getPath('userData'), `.write-check-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'x')
    fs.rmSync(probe, { force: true })
    return null
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
  }
}

// Two instances writing one SQLite file is a corruption risk — focus the first.
if (!app.requestSingleInstanceLock()) {
  // Chromium also fails to take the lock when it cannot create the lock file (a read-only
  // folder, a full disk). Quitting then would look like the app not starting at all.
  const writeError = userDataWriteError()
  if (!writeError) app.quit()
  else {
    void app.whenReady().then(async () => {
      const s = MAIN_STRINGS[mainLocale()]
      await dialog.showMessageBox({
        type: 'error',
        title: APP_NAME,
        message: s.cannotWrite,
        detail: fillText(s.cannotWriteDetail, { file: app.getPath('userData'), code: writeError }),
        buttons: [s.quit],
      })
      app.quit()
    })
  }
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      if (db) createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    plansRoot = defaultClaudePlansRoot()
    const opened = await openVaultDbOrAsk()
    if (!opened) {
      app.quit()
      return
    }
    db = opened.db
    noteAppOpen()
    app.on('browser-window-focus', noteAppOpen)
    const dbFile = vaultDbPath()
    queryService = new QueryService(dbFile)
    indexService = new IndexService({
      dbFile,
      plansRoot,
      onProgress: broadcastIndexProgress,
      onUpdated: broadcastIndexUpdated,
      onError: (message) => reportFatal(MAIN_STRINGS[mainLocale()].initialIndex, message),
    })
    registerIpc()
    // Show the window first, then index on the worker so a large ~/.claude never
    // delays first paint. The watcher starts once the initial pass finishes.
    createWindow()
    applyContentSecurityPolicy()
    mainWindow?.webContents.once('did-finish-load', () => {
      reportOpenOutcome(opened.outcome)
      indexService!.start()
      void indexService!
        .scan()
        .then(() => {
          startWatcher()
          scheduleDailyBackups()
        })
        .catch((err) => reportFatal(MAIN_STRINGS[mainLocale()].initialIndex, err))
      initAutoUpdate(liveWindow, readSettings().autoUpdate)
    })
  }).catch(async (err) => {
    // No window will follow: say why, then leave rather than stay running with nothing to show.
    await reportFatal('startup', err)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  // Without the DB (a startup dialog is up, or the app is closing) a window would be empty.
  if (db && BrowserWindow.getAllWindows().length === 0) createWindow()
})

let shuttingDown = false

/** Closes the watcher and every DB connection (both workers and main). */
async function closeAll() {
  try {
    await watcher?.close()
    await Promise.all([indexService?.stop(), queryService?.stop()])
    db?.close()
  } catch {
    /* closing an already-closed handle is fine */
  }
  db = null
}

app.on('before-quit', (event) => {
  if (shuttingDown) return
  // Let both workers close their DB handles cleanly before the process exits.
  shuttingDown = true
  event.preventDefault()
  void closeAll().then(() => app.quit())
})

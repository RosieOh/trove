import fs from 'node:fs'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc.js'
import type { UpdateStatus } from '../shared/ipc.js'

/**
 * Auto-update via electron-updater.
 *
 * Deliberately conservative: downloads happen in the background but installing
 * is always the user's call — this app is opened to look something up, and a
 * surprise restart mid-search would lose the user's place.
 *
 * Only meaningful in a packaged, code-signed build. In dev (or unsigned) the
 * updater is skipped entirely rather than logging errors on every launch.
 *
 * The update check is the app's only network request (ADR-0005), so it can be turned
 * off in Settings; when off, nothing is loaded and no request is made.
 */

let status: UpdateStatus = { state: 'idle' }
/** Asked on every push: the window can close, and a later one can take its place. */
let getWindow: (() => BrowserWindow | null) | null = null
let enabled = true
let timer: ReturnType<typeof setInterval> | null = null
let wired = false

function push(next: UpdateStatus) {
  status = next
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.onUpdateStatus, next)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/**
 * macOS builds made without a Developer ID cannot install updates: Squirrel.Mac checks
 * the new version's signature against the running app's, and an ad-hoc signature never
 * matches. The release workflow marks those builds in the packaged package.json
 * (`"vault": { "unsignedMac": true }`) so they skip the check instead of downloading a
 * 200 MB update that then fails. Windows and Linux update fine unsigned.
 */
function isUnsignedMacBuild(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as {
      vault?: { unsignedMac?: unknown }
    }
    return pkg.vault?.unsignedMac === true
  } catch {
    return false
  }
}

/** True when an update feed can actually work (packaged build with a publish config). */
export function updatesSupported(): boolean {
  return app.isPackaged && !process.env.VAULT_DISABLE_UPDATER && !isUnsignedMacBuild()
}

type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  on: (event: string, cb: (...args: unknown[]) => void) => void
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (silent?: boolean, forceRunAfter?: boolean) => void
}

let updater: Updater | null = null

function load(): Updater | null {
  if (updater) return updater
  try {
    // Required lazily (the main bundle is CommonJS) so dev runs never pay for it
    // and a missing/failed module degrades to "updates unavailable" rather than
    // blocking startup. A static import would load it on every launch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron-updater') as { autoUpdater: Updater }
    updater = mod.autoUpdater
    return updater
  } catch (err) {
    console.error('[vault] electron-updater unavailable:', err)
    return null
  }
}

export function initAutoUpdate(currentWindow: () => BrowserWindow | null, isEnabled: boolean): void {
  getWindow = currentWindow
  enabled = isEnabled
  if (!updatesSupported()) {
    push({ state: 'unsupported' })
    return
  }
  if (!enabled) {
    push({ state: 'disabled' })
    return
  }

  const au = load()
  if (!au) {
    push({ state: 'unsupported' })
    return
  }

  au.autoDownload = true
  au.autoInstallOnAppQuit = false
  if (wired) return startChecks()
  wired = true

  au.on('checking-for-update', () => push({ state: 'checking' }))
  au.on('update-not-available', () => push({ state: 'idle' }))
  au.on('update-available', (info) => {
    const version = (info as { version?: string })?.version
    push({ state: 'downloading', version, percent: 0 })
  })
  au.on('download-progress', (p) => {
    const percent = Math.round((p as { percent?: number })?.percent ?? 0)
    push({ ...status, state: 'downloading', percent })
  })
  au.on('update-downloaded', (info) => {
    const version = (info as { version?: string })?.version
    push({ state: 'ready', version })
  })
  au.on('error', (err) => {
    push({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  })

  startChecks()
}

function startChecks() {
  void checkForUpdates()
  // A long-lived window should still notice releases; daily is plenty here.
  if (!timer) timer = setInterval(() => void checkForUpdates(), 24 * 60 * 60 * 1000)
}

/** Settings toggle. Turning it off stops future checks; an already-downloaded update stays installable. */
export function setAutoUpdateEnabled(next: boolean): void {
  enabled = next
  if (!next) {
    if (timer) clearInterval(timer)
    timer = null
    if (status.state !== 'ready') push({ state: updatesSupported() ? 'disabled' : 'unsupported' })
    return
  }
  if (getWindow) initAutoUpdate(getWindow, true)
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!updatesSupported()) {
    push({ state: 'unsupported' })
    return status
  }
  if (!enabled) {
    push({ state: 'disabled' })
    return status
  }
  const au = load()
  if (!au) return status
  try {
    await au.checkForUpdates()
  } catch (err) {
    push({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  return status
}

/** Restart into the downloaded update. No-op unless one is ready. */
export function installUpdate(): void {
  if (status.state !== 'ready') return
  load()?.quitAndInstall(false, true)
}

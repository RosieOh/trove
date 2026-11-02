#!/usr/bin/env node
/**
 * End-to-end smoke test of the built app (`dist/`, `dist-electron/` — run `vite build`
 * first). Launches Electron with Playwright against a temporary copy of
 * `tests/e2e/fixtures`, drives the UI, and checks the promises unit tests cannot:
 * the window starts, the workers index, search / prompts / stats / plans / Codex work,
 * live updates and archiving react to file changes, indexing carries on with the window
 * closed, the daily backup runs, the renderer logs no errors, the app writes nothing into
 * the transcript folders, and a DB it must not touch is refused with a dialog.
 *
 *   npm run test:e2e            (Linux CI: xvfb-run -a npm run test:e2e)
 *
 * On failure a screenshot and the main-process log go to `e2e-artifacts/`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const artifacts = path.join(root, 'e2e-artifacts')

if (!fs.existsSync(path.join(root, 'dist-electron', 'main.cjs')) || !fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('Build the app first: npx vite build')
  process.exit(1)
}

// Fixtures are copied so the run can append to / delete transcripts like Claude Code does.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-e2e-'))
const claudeHome = path.join(tmp, 'claude')
const codexHome = path.join(tmp, 'codex')
const userData = path.join(tmp, 'user')
fs.cpSync(path.join(root, 'tests', 'e2e', 'fixtures'), tmp, { recursive: true })
const projectDir = path.join(claudeHome, 'projects', '-work-demo')
const sessionA = path.join(projectDir, '0e2e0000-0000-4000-8000-00000000000a.jsonl')
const sessionB = path.join(projectDir, '0e2e0000-0000-4000-8000-00000000000b.jsonl')
const planFile = path.join(claudeHome, 'plans', 'login-validation.md')

/** relPath → size:mtime for every file and directory under the transcript roots. */
function snapshotTree(dirs) {
  const out = new Map()
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const st = fs.statSync(p)
      out.set(path.relative(tmp, p), e.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}`)
      if (e.isDirectory()) walk(p)
    }
  }
  for (const d of dirs) walk(d)
  return out
}
const before = snapshotTree([claudeHome, codexHome])

const env = { ...process.env, CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome, VAULT_USER_DATA: userData, VAULT_DISABLE_UPDATER: '1' }
// VS Code's extension host exports this; with it set Electron starts as plain Node.
delete env.ELECTRON_RUN_AS_NODE
// GitHub's Ubuntu runners cannot set up Chromium's sandbox (unprivileged user namespaces).
const args = process.platform === 'linux' && process.env.CI ? ['--no-sandbox', root] : [root]

const results = []
let app
let page
const mainLog = []
const rendererErrors = []

async function step(name, fn) {
  const t = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - t })
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`)
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t })
    console.log(`  ✗ ${name}\n    ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n    ')}`)
    throw err
  }
}

/** Polls `fn` until it returns a truthy value. */
async function until(fn, { timeout = 20_000, interval = 200, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${what} (last: ${JSON.stringify(last)})`)
}

const vault = (fn, arg) => page.evaluate(fn, arg)
const nav = (re) => page.getByRole('button', { name: re }).first().click()

function watchRenderer(p) {
  p.on('console', (m) => m.type() === 'error' && rendererErrors.push(m.text()))
  p.on('pageerror', (e) => rendererErrors.push(`pageerror: ${e.message}`))
}

/** Dialogs the main process has raised since launch (see the recorder installed below). */
const dialogCalls = () => app.evaluate(() => globalThis.__e2eDialogs)

/**
 * Runs the app until it quits by itself, with every dialog recorded and answered by
 * `record-dialogs.cjs`. For startups that end in a dialog, where there is no window for
 * Playwright to drive and `whenReady` has passed before it could install anything.
 */
function launchToDialog(dataDir) {
  const log = path.join(tmp, `dialogs-${path.basename(dataDir)}.jsonl`)
  const stub = path.join(root, 'tests', 'e2e', 'record-dialogs.cjs')
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron'), ['-r', stub, ...args], {
      env: { ...env, VAULT_USER_DATA: dataDir, E2E_DIALOG_LOG: log },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the app did not quit after its dialog'))
    }, 45_000)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
      resolve({ code, dialogs: lines.map((l) => JSON.parse(l)) })
    })
  })
}

let failed = false
try {
  console.log('Trove e2e smoke test')

  await step('window opens', async () => {
    app = await _electron.launch({ executablePath: require('electron'), args, env, timeout: 60_000 })
    app.process().stdout?.on('data', (d) => mainLog.push(String(d)))
    app.process().stderr?.on('data', (d) => mainLog.push(String(d)))
    page = await app.firstWindow()
    watchRenderer(page)
    await page.waitForLoadState('domcontentloaded')
    assert.equal(await page.title(), 'Trove')
    // reportFatal raises showMessageBox and Electron's own handler raises showErrorBox, so
    // record both: a dialog nobody answers would hang the run, and neither may appear.
    await app.evaluate(({ dialog }) => {
      globalThis.__e2eDialogs = []
      for (const name of ['showErrorBox', 'showMessageBox']) {
        dialog[name] = async (...a) => {
          const box = a.find((x) => x?.message) ?? { message: a.join(' ') }
          globalThis.__e2eDialogs.push({ name, message: box.message, detail: box.detail })
          return { response: 0, checkboxChecked: false }
        }
      }
    })
  })

  await step('initial index finishes on the workers', async () => {
    const stats = await until(
      async () => {
        const s = await vault(() => window.vault.stats())
        const busy = await vault(() => /색인 중|Indexing/.test(document.body.innerText))
        return !busy && s.totalPrompts >= 3 ? s : null
      },
      { timeout: 60_000, what: 'index' },
    )
    // Two typed prompts in Claude sessions + one in Codex; the tool result is not a prompt.
    assert.equal(stats.totalPrompts, 3)
  })

  await step('search from the UI finds a word that only an answer contains', async () => {
    await nav(/^(검색|Search)$/)
    // Recent-session previews show prompts, not answers: the word must not be on screen yet.
    assert.equal(await page.locator('main').getByText(/zephyrquartz/).count(), 0)
    const input = page.locator('.search-field input')
    await input.fill('zephyrquartz')
    await page.locator('main').getByText(/zephyrquartz/).first().waitFor({ timeout: 15_000 })
    const hits = await vault(() => window.vault.search({ query: '보라색여우', excludeMeta: true, excludeTools: true, limit: 20 }))
    assert.equal(hits?.length, 1, 'Korean token search')
  })

  await step('my prompts lists typed prompts, not tool results', async () => {
    await nav(/^(내 프롬프트|My prompts)$/)
    await page.locator('main').getByText('Explain why the login form rejects valid emails').waitFor({ timeout: 10_000 })
    const rows = await vault(() => window.vault.promptsList({ sort: 'recent', limit: 50 }))
    assert.equal(rows.length, 3)
    assert.ok(!rows.some((r) => /has been updated/.test(r.text)), 'tool result counted as a prompt')
  })

  await step('stats count tokens once per response and price the models', async () => {
    await nav(/^(통계|Stats)$/)
    await page.locator('main').getByText(/claude-opus-5-5/).first().waitFor({ timeout: 10_000 })
    const s = await vault(() => window.vault.stats())
    const opus = s.tokensByModel.find((m) => m.model === 'claude-opus-5-5')
    // Two responses, each one line here; a response repeated over lines would still count once.
    assert.equal(opus?.messages, 2)
    assert.equal(opus?.output, 65)
    // This launch counts as a day the app was opened (roadmap go/no-go measure).
    const p = (n) => String(n).padStart(2, '0')
    const now = new Date()
    assert.deepEqual(s.appOpenDays, [`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`])
    await page.locator('main').getByText(/Trove를 연 날|Days you opened Trove/).waitFor({ timeout: 5_000 })
  })

  await step('plans and Codex sessions are indexed', async () => {
    const plans = await vault(() => window.vault.search({ query: 'plumbagomarker', scope: 'plans', limit: 10 }))
    assert.equal(plans?.length, 1, 'plan hit')
    const projects = await vault(() => window.vault.projectsList())
    assert.ok(
      projects.some((p) => p.tool === 'codex' && /codex-demo/.test(p.displayName)),
      `codex project missing: ${JSON.stringify(projects.map((p) => [p.tool, p.displayName]))}`,
    )
  })

  await step('an appended line shows up live', async () => {
    const line = {
      type: 'user',
      uuid: 'e2e-u9',
      timestamp: '2026-10-04T10:00:00.000Z',
      cwd: '/work/demo',
      message: { role: 'user', content: [{ type: 'text', text: 'one more liveappendword question' }] },
    }
    fs.appendFileSync(sessionA, `${JSON.stringify(line)}\n`)
    await until(
      async () => (await vault(() => window.vault.search({ query: 'liveappendword', limit: 5 })))?.length === 1,
      { timeout: 30_000, what: 'live update' },
    )
  })

  await step('a deleted transcript and a deleted plan stay searchable as archived', async () => {
    fs.rmSync(sessionB)
    fs.rmSync(planFile)
    await until(
      async () => {
        const hits = await vault(() => window.vault.search({ query: 'archivedsentinel', limit: 5 }))
        return hits?.length === 1 && hits[0].archived === true
      },
      { timeout: 30_000, what: 'archived session hit' },
    )
    await until(
      async () => {
        const hits = await vault(() => window.vault.search({ query: 'plumbagomarker', scope: 'plans', limit: 5 }))
        return hits?.length === 1 && hits[0].archived === true
      },
      { timeout: 30_000, what: 'archived plan hit' },
    )
  })

  await step('with the window closed, indexing goes on and no error dialog appears', async () => {
    const sameWord = 'closedwindowword'
    // Windows and Linux quit when the last window closes; hold that for this step so it
    // runs the path macOS users hit, where the app stays alive with no window.
    await app.evaluate(({ app: a }) => {
      globalThis.__e2eQuitOnClose = a.listeners('window-all-closed')
      a.removeAllListeners('window-all-closed')
      a.on('window-all-closed', () => {})
    })
    const closed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed

    for (let i = 0; i < 3; i += 1) {
      const line = {
        type: 'user',
        uuid: `e2e-closed-${i}`,
        timestamp: '2026-10-04T11:00:00.000Z',
        cwd: '/work/demo',
        message: { role: 'user', content: [{ type: 'text', text: `${sameWord} line ${i}` }] },
      }
      fs.appendFileSync(sessionA, `${JSON.stringify(line)}\n`)
    }
    // No renderer to ask, so read the DB directly (WAL lets a second process do that).
    const Database = require('better-sqlite3')
    const indexed = () => {
      const db = new Database(path.join(userData, 'vault.db'), { readonly: true, fileMustExist: true })
      try {
        return db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE msg_key LIKE 'e2e-closed-%'`).get().c
      } finally {
        db.close()
      }
    }
    await until(() => indexed() === 3, { timeout: 30_000, what: 'lines indexed with no window' })
    // The "index changed" ping goes out right after the commit: give it time to arrive.
    await new Promise((r) => setTimeout(r, 1500))
    assert.deepEqual(await dialogCalls(), [])

    // Back to one window, which must see the lines and get every later push.
    const reopened = app.waitForEvent('window')
    await app.evaluate(({ app: a }) => {
      a.removeAllListeners('window-all-closed')
      for (const l of globalThis.__e2eQuitOnClose) a.on('window-all-closed', l)
      a.emit('activate')
    })
    page = await reopened
    watchRenderer(page)
    await page.waitForLoadState('domcontentloaded')
    await until(
      async () => (await vault((q) => window.vault.search({ query: q, limit: 5 }), sameWord))?.length === 3,
      { what: 'closed-window lines in the reopened window' },
    )
    // The updater pushes to the window too: toggling it must reach this one, not the closed one.
    await vault(() => window.vault.settingsSet({ autoUpdate: false }))
    await vault(() => window.vault.settingsSet({ autoUpdate: true }))
    assert.deepEqual(await dialogCalls(), [])
  })

  await step('a repeated failure raises one dialog, a different failure its own', async () => {
    const shown = await app.evaluate(() => {
      const repeated = new Error('e2e repeated failure')
      process.emit('uncaughtException', repeated)
      process.emit('uncaughtException', repeated)
      process.emit('uncaughtException', new Error('e2e other failure'))
      const calls = globalThis.__e2eDialogs.splice(0)
      return calls.map((c) => [c.name, /e2e (repeated|other) failure/.exec(c.detail ?? '')?.[1]])
    })
    assert.deepEqual(shown, [
      ['showMessageBox', 'repeated'],
      ['showMessageBox', 'other'],
    ])
  })

  await step('the daily backup is written after the first scan', async () => {
    const info = await until(async () => {
      const b = await vault(() => window.vault.backupsList())
      return b.items.length ? b : null
    }, { what: 'backup' })
    assert.equal(info.items[0].reason, 'daily')
    assert.ok(info.dir.startsWith(userData), `backups outside userData: ${info.dir}`)
  })

  await step('settings and the other tabs render', async () => {
    for (const re of [/^(파일|Files)$/, /^(즐겨찾기|Favorites)$/, /^(템플릿|Templates)$/, /^(보내기|Export)$/, /^(설정|Settings)$/]) {
      await nav(re)
      await page.waitForTimeout(300)
    }
    await page.getByRole('heading', { name: /^(백업|Backups)$/ }).waitFor({ timeout: 5_000 })
    // The error boundary's fallback title (ErrorBoundary.tsx, `error.title`).
    const crashed = await vault(() => /화면을 그리지 못했어요|Could not render the screen/.test(document.body.innerText))
    assert.equal(crashed, false, 'error boundary visible')
  })

  await step('the renderer logged no errors', async () => {
    assert.deepEqual(rendererErrors, [])
  })

  await step('the app quits cleanly', async () => {
    await Promise.race([
      app.close(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('app did not quit within 15 s')), 15_000)),
    ])
    app = null
  })

  await step('nothing was written under the transcript roots', async () => {
    const after = snapshotTree([claudeHome, codexHome])
    const touched = new Set([sessionA, sessionB, planFile].map((p) => path.relative(tmp, p)))
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (k) => !touched.has(k) && before.get(k) !== after.get(k) && !(before.get(k) === 'dir' && after.get(k) === 'dir'),
    )
    assert.deepEqual(changed, [])
    // Directory mtimes change when *we* add/remove files; any new entry would be listed above.
  })

  await step('a DB from a newer build is refused with a dialog and left untouched', async () => {
    const dataDir = path.join(tmp, 'user-newer')
    fs.mkdirSync(dataDir)
    const dbFile = path.join(dataDir, 'vault.db')
    const Database = require('better-sqlite3')
    const db = new Database(dbFile)
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '9999');`)
    db.close()
    const bytes = fs.readFileSync(dbFile)

    const { code, dialogs } = await launchToDialog(dataDir)
    assert.equal(code, 0)
    assert.equal(dialogs.length, 1, JSON.stringify(dialogs))
    assert.match(dialogs[0].detail, /9999/)
    assert.ok(dialogs[0].detail.includes(dbFile), dialogs[0].detail)
    assert.equal(dialogs[0].buttons.length, 1, 'only a quit button')
    assert.ok(fs.readFileSync(dbFile).equals(bytes), 'the DB changed')
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.startsWith('vault.db') && f !== 'vault.db'), [])
    assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false)
  })

  await step('a DB that went missing comes back from its backup, and the user is told', async () => {
    const files = fs.readdirSync(userData).filter((f) => /^vault\.db(-wal|-shm)?$/.test(f))
    for (const f of files) fs.rmSync(path.join(userData, f))
    const log = path.join(tmp, 'dialogs-missing.jsonl')
    app = await _electron.launch({
      executablePath: require('electron'),
      args: ['-r', path.join(root, 'tests', 'e2e', 'record-dialogs.cjs'), ...args],
      env: { ...env, E2E_DIALOG_LOG: log },
      timeout: 60_000,
    })
    page = await app.firstWindow()
    const dialogs = await until(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : null), {
      what: 'the recovery dialog',
    })
    assert.equal(dialogs.length, 1, JSON.stringify(dialogs))
    assert.match(dialogs[0].detail, /vault-\d{8}-\d{6}-daily\.db/)
    // The session deleted earlier exists only in the vault, so only the backup can bring it back.
    await until(async () => {
      const hits = await vault(() => window.vault.search({ query: 'archivedsentinel', limit: 5 }))
      return hits?.length === 1 && hits[0].archived === true
    }, { timeout: 30_000, what: 'the archived session in the restored DB' })
    await app.close()
    app = null
  })

  // A chmod means nothing to Windows, and root ignores it.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await step('a read-only data folder explains itself instead of quitting silently', async () => {
      const dataDir = path.join(tmp, 'user-readonly')
      fs.mkdirSync(dataDir)
      fs.chmodSync(dataDir, 0o555)
      try {
        const { code, dialogs } = await launchToDialog(dataDir)
        assert.equal(code, 0)
        assert.equal(dialogs.length, 1, JSON.stringify(dialogs))
        assert.ok(dialogs[0].detail.includes(dataDir), dialogs[0].detail)
        assert.equal(dialogs[0].buttons.length, 1, 'only a quit button')
      } finally {
        fs.chmodSync(dataDir, 0o755)
      }
    })

    await step('a read-only DB file in a writable folder offers a retry instead of opening', async () => {
      const dataDir = path.join(tmp, 'user-readonly-db')
      fs.mkdirSync(dataDir)
      const dbFile = path.join(dataDir, 'vault.db')
      fs.copyFileSync(path.join(userData, 'vault.db'), dbFile)
      fs.chmodSync(dbFile, 0o444)
      const bytes = fs.readFileSync(dbFile)
      const { code, dialogs } = await launchToDialog(dataDir)
      fs.chmodSync(dbFile, 0o644)
      assert.equal(code, 0)
      assert.equal(dialogs.length, 1, JSON.stringify(dialogs))
      assert.ok(dialogs[0].detail.includes(dbFile), dialogs[0].detail)
      assert.match(dialogs[0].detail, /EACCES/)
      assert.equal(dialogs[0].buttons.length, 2, 'try again and quit')
      assert.ok(fs.readFileSync(dbFile).equals(bytes), 'the DB changed')
      assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.startsWith('vault.db') && f !== 'vault.db'), [])
    })

    await step('a backup folder that cannot be written is the path the dialog names', async () => {
      const dataDir = path.join(tmp, 'user-readonly-backups')
      const backups = path.join(dataDir, 'backups')
      fs.mkdirSync(backups, { recursive: true })
      const dbFile = path.join(dataDir, 'vault.db')
      const Database = require('better-sqlite3')
      const db = new Database(dbFile)
      db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES ('schema_version', '9');`)
      db.close()
      const bytes = fs.readFileSync(dbFile)
      fs.chmodSync(backups, 0o555)
      try {
        const { code, dialogs } = await launchToDialog(dataDir)
        assert.equal(code, 0)
        assert.equal(dialogs.length, 1, JSON.stringify(dialogs))
        assert.ok(dialogs[0].detail.includes(backups), dialogs[0].detail)
        assert.match(dialogs[0].detail, /EACCES/)
        assert.ok(fs.readFileSync(dbFile).equals(bytes), 'migrated with no copy')
      } finally {
        fs.chmodSync(backups, 0o755)
      }
    })
  }
} catch {
  failed = true
  fs.mkdirSync(artifacts, { recursive: true })
  try {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png') })
  } catch {
    /* window already gone */
  }
  fs.writeFileSync(path.join(artifacts, 'main.log'), mainLog.join(''))
  fs.writeFileSync(path.join(artifacts, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2))
} finally {
  await app?.close().catch(() => {})
  fs.rmSync(tmp, { recursive: true, force: true })
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} steps passed${failed ? ` — see ${path.relative(root, artifacts)}/` : ''}`)
process.exit(failed ? 1 : 0)

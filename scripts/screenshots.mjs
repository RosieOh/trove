#!/usr/bin/env node
/**
 * README screenshots from the synthetic demo corpus (scripts/demo-corpus.mjs), never from
 * a real ~/.claude. Build first, then:
 *   npx vite build && node scripts/screenshots.mjs [outDir=docs/images]
 * Launches the built app with Playwright against a temporary corpus and profile,
 * English UI, sRGB colours, a 1280×800 window at 1.25× scale (1600×1000 PNGs: sharp at
 * README width on a retina screen, without megabyte files).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'docs', 'images'))
fs.mkdirSync(outDir, { recursive: true })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-shots-'))
execFileSync(process.execPath, [path.join(root, 'scripts', 'demo-corpus.mjs'), tmp], { stdio: 'inherit' })
const userData = path.join(tmp, 'user')
const env = {
  ...process.env,
  CLAUDE_HOME: path.join(tmp, 'claude'),
  CODEX_HOME: path.join(tmp, 'codex'),
  VAULT_USER_DATA: userData,
  VAULT_DISABLE_UPDATER: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['--force-color-profile=srgb', '--force-device-scale-factor=1.25', root],
  env,
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
await page.waitForLoadState('domcontentloaded')
// Switch language the way a user does (Settings → English). Writing localStorage and
// reloading races the app, which stores the OS language on startup.
await page.getByRole('button', { name: /^(설정|Settings)$/ }).first().click()
await page.getByRole('button', { name: 'English', exact: true }).click()
await page.getByRole('heading', { name: 'Backups' }).waitFor()
await page.evaluate(() => document.documentElement.classList.remove('dark'))

const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return
    await page.waitForTimeout(150)
  }
  throw new Error(`timed out waiting for ${what}`)
}
await until(
  () => page.evaluate(async () => (await window.vault.stats()).totalPrompts > 0 && !/Indexing/.test(document.body.innerText)),
  'index',
)

// A little user data so the screens look used: two favorites, two tags, and four weeks
// of "days you opened Trove" (written straight into the scratch DB).
await page.evaluate(async () => {
  const hits = (await window.vault.search({ query: 'retry', limit: 10, excludeTools: true })) ?? []
  const msgs = hits.filter((h) => h.hitType === 'message')
  const bug = await window.vault.tagCreate('bug', '#e5484d')
  const perf = await window.vault.tagCreate('perf', '#3e63dd')
  if (msgs[0]) {
    await window.vault.favoriteAdd(msgs[0].messageId)
    await window.vault.messageTagsSet(msgs[0].msgKey, [bug])
  }
  if (msgs[1]) await window.vault.messageTagsSet(msgs[1].msgKey, [perf])
})
{
  const Database = require('better-sqlite3')
  const db = new Database(path.join(userData, 'vault.db'))
  const p = (n) => String(n).padStart(2, '0')
  const ins = db.prepare(`INSERT OR IGNORE INTO app_opens (day) VALUES (?)`)
  for (const off of [0, 1, 3, 4, 7, 8, 9, 11, 14, 16, 17, 18, 21, 24]) {
    const d = new Date(Date.now() - off * 86_400_000)
    ins.run(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
  }
  db.close()
}

const nav = (name) => page.getByRole('button', { name, exact: true }).first().click()
const shot = async (name) => {
  await page.mouse.move(1270, 790) // no hover tooltips
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(outDir, `${name}.png`) })
  console.log(`  ${name}.png`)
}
const theme = (dark) => page.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark)

await nav('Search')
await page.locator('.search-field input').fill('retry')
await page.locator('main').getByText(/retry/i).first().waitFor()
await shot('search')
await theme(true)
await shot('search-dark')
await theme(false)

await page.getByRole('button', { name: 'Session', exact: true }).first().click()
await page.getByRole('dialog').waitFor()
await shot('transcript')
await page.keyboard.press('Escape')

await nav('Sessions')
await page.locator('main [data-index="0"]').waitFor()
await shot('sessions')

// A session with a tool edit, tool rows shown, scrolled to the first diff.
await page.locator('main [data-index="0"] button').first().click()
await page.getByRole('dialog').waitFor()
await page.getByLabel('Show tool calls and results').check()
await page.locator('.diff').first().waitFor()
// Scroll the transcript pane, not the dialog (scrollIntoView would move the header away).
await page.locator('.diff').first().evaluate((el) => {
  const body = el.closest('[data-transcript-body]')
  body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3
})
await shot('diff')
await page.keyboard.press('Escape')

await nav('My prompts')
await page.getByRole('button', { name: 'Most used', exact: true }).click()
await page.waitForTimeout(400)
await shot('prompts')

await nav('Stats')
await page.getByText('Days you opened Trove').waitFor()
await shot('stats')
await theme(true)
await shot('stats-dark')

await app.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`screenshots → ${path.relative(root, outDir)}`)

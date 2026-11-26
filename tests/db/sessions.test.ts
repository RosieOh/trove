import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { indexSessionFile, handleSessionUnlink } from '../../electron/indexer'
import { openVaultDb, SCHEMA_VERSION } from '../../electron/db'
import { exportSession, handoffPrompt, listSessions, sessionDetail, transcriptPage } from '../../electron/sessions'
import { unifiedSearch } from '../../electron/search'
import { assistantLine, metaLine, sandbox, userLine, writeLines } from './helpers'
import { summarizeToolUse } from '../../shared/jsonlParse'

const S1 = 'a3985005-5f84-4b01-ad40-4772a6198e12'
const S2 = '755f3e81-4e45-46d4-b838-a4bab756704d'

const lineWith = (base: string, extra: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(base), ...extra })

async function seed() {
  const sb = sandbox()
  const db = sb.open()
  const pid = sb.project(db)
  const f1 = path.join(sb.projectRoot, `${S1}.jsonl`)
  writeLines(f1, [
    lineWith(userLine('u1', 'fix the build error', '2026-10-01T10:00:00.000Z'), { cwd: '/work/app', gitBranch: 'main' }),
    metaLine('Build error fix'),
    assistantLine('a1', 'done, the key was API_KEY=abcdef1234567'),
    lineWith(userLine('u2', 'now add tests', '2026-10-02T10:00:00.000Z'), { gitBranch: 'feat/tests' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My renamed session' }),
  ])
  const f2 = path.join(sb.projectRoot, `${S2}.jsonl`)
  writeLines(f2, [lineWith(userLine('v1', 'second session prompt', '2026-09-01T10:00:00.000Z'), { cwd: '/work/app' })])
  const subDir = path.join(sb.projectRoot, S1, 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  const sub = path.join(subDir, 'agent-abc.jsonl')
  writeLines(sub, [
    lineWith(userLine('s1', 'subagent task'), { isSidechain: true }),
    assistantLine('s2', 'sub answer', { msgId: 'msg_sub', requestId: 'req_sub' }),
  ])
  for (const filePath of [f1, f2, sub]) await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath })
  const id = (rel: string) => (db.prepare(`SELECT id FROM sessions WHERE rel_path = ?`).get(rel) as { id: number }).id
  return { sb, db, pid, f1, f2, sub, id1: id(`${S1}.jsonl`), id2: id(`${S2}.jsonl`), subId: id(path.join(S1, 'subagents', 'agent-abc.jsonl')) }
}

describe('session summaries', () => {
  it('keeps title, cwd, branch and time span on the session row', async () => {
    const { db, id1 } = await seed()
    const row = db.prepare(`SELECT title, title_rank, cwd, git_branch, first_ts_ms, last_ts_ms FROM sessions WHERE id = ?`).get(id1)
    expect(row).toEqual({
      title: 'My renamed session',
      title_rank: 3,
      cwd: '/work/app',
      git_branch: 'feat/tests',
      first_ts_ms: Date.parse('2026-10-01T10:00:00.000Z'),
      last_ts_ms: Date.parse('2026-10-02T10:00:00.000Z'),
    })
  })

  it('an ai-title after a custom title does not replace it', async () => {
    const { db, sb, f1, pid, id1 } = await seed()
    fs.appendFileSync(f1, `${metaLine('Later AI title')}\n`)
    const t = new Date(Date.now() + 2000)
    fs.utimesSync(f1, t, t)
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: f1 })
    expect((db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(id1) as { title: string }).title).toBe('My renamed session')
  })

  it('backfills summaries when a v10 database is migrated, archived sessions included', async () => {
    const { db, sb, id1 } = await seed()
    db.prepare(`UPDATE sessions SET title = NULL, title_rank = NULL, cwd = NULL, git_branch = NULL, first_ts_ms = NULL, last_ts_ms = NULL`).run()
    db.prepare(`UPDATE sessions SET archived_at = 1 WHERE id = ?`).run(id1)
    db.prepare(`UPDATE meta SET value = '10' WHERE key = 'schema_version'`).run()
    db.close()
    // A v10 file has no summary columns at all.
    const raw = new Database(sb.dbFile)
    for (const c of ['title', 'title_rank', 'cwd', 'git_branch', 'first_ts_ms', 'last_ts_ms']) raw.exec(`ALTER TABLE sessions DROP COLUMN ${c}`)
    raw.close()
    const again = openVaultDb(sb.dbFile)
    try {
      const row = again.prepare(`SELECT title, cwd, git_branch, first_ts_ms FROM sessions WHERE id = ?`).get(id1) as Record<string, unknown>
      // The backfill reads the `[제목] …` rows; a custom-title line is stored the same way.
      expect(row.title).toBe('My renamed session')
      expect(row.cwd).toBe('/work/app')
      expect(row.git_branch).toBe('feat/tests')
      expect(row.first_ts_ms).toBe(Date.parse('2026-10-01T10:00:00.000Z'))
      expect((again.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe(
        String(SCHEMA_VERSION),
      )
    } finally {
      again.close()
    }
  })
})

describe('listSessions / sessionDetail', () => {
  it('lists top-level sessions with subagent counts, newest first', async () => {
    const { db, id1, id2 } = await seed()
    const res = listSessions(db, {})
    expect(res.total).toBe(2)
    expect(res.rows.map((r) => r.sessionId)).toEqual([id1, id2])
    expect(res.rows[0]).toMatchObject({ title: 'My renamed session', subagentCount: 1, preview: 'fix the build error', archived: false })
    expect(listSessions(db, { sort: 'oldest' }).rows[0].sessionId).toBe(id2)
    expect(listSessions(db, { query: 'second session' }).rows.map((r) => r.sessionId)).toEqual([id2])
    expect(listSessions(db, { query: 'feat/tests' }).rows.map((r) => r.sessionId)).toEqual([id1])
    expect(listSessions(db, { limit: 1, offset: 1 }).rows.map((r) => r.sessionId)).toEqual([id2])
  })

  it('filters archived sessions', async () => {
    const { db, f2, id2 } = await seed()
    handleSessionUnlink(db, f2, 'keep')
    expect(listSessions(db, { archived: 'archived' }).rows.map((r) => r.sessionId)).toEqual([id2])
    expect(listSessions(db, { archived: 'live' }).total).toBe(1)
  })

  it('details a session: resume command, subagents, tokens counted once per response', async () => {
    const { db, id1, subId } = await seed()
    const d = sessionDetail(db, id1, 'darwin')!
    expect(d.resumeCommand).toBe(`cd /work/app && claude --resume ${S1}`)
    expect(d.forkCommand).toContain('--fork-session')
    expect(d.promptCount).toBe(2)
    expect(d.subagents.map((s) => s.sessionId)).toEqual([subId])
    // Main session response msg_1 + the subagent's msg_sub.
    expect(d.tokensByModel).toEqual([
      expect.objectContaining({ model: 'claude-opus-5-5', messages: 2, input: 20, output: 10 }),
    ])
    const sub = sessionDetail(db, subId, 'darwin')!
    expect(sub.parentSessionId).toBe(id1)
  })
})

describe('transcriptPage', () => {
  it('pages by position and starts a little before a requested line', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const f = path.join(sb.projectRoot, `${S1}.jsonl`)
    writeLines(
      f,
      Array.from({ length: 300 }, (_, i) => userLine(`u${i}`, `line ${i}`)),
    )
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: f })
    const sid = (db.prepare(`SELECT id FROM sessions`).get() as { id: number }).id
    const first = transcriptPage(db, sid, { limit: 100 })
    expect(first).toMatchObject({ from: 0, total: 300 })
    expect(first.rows).toHaveLength(100)
    const around = transcriptPage(db, sid, { aroundLine: 250, limit: 100 })
    expect(around.from).toBe(240)
    expect(around.rows[0].lineIndex).toBe(240)
    expect(around.rows.some((r) => r.lineIndex === 250)).toBe(true)
  })
})

describe('exportSession / handoffPrompt', () => {
  it('exports Markdown and HTML, masking secrets when asked', async () => {
    const { db, id1 } = await seed()
    const md = exportSession(db, id1, 'md', { mask: true, locale: 'ko' })
    expect(md.text).toContain('# My renamed session')
    expect(md.text).toContain('fix the build error')
    expect(md.text).toContain('API_KEY=••••')
    expect(md.masked).toBe(1)
    const raw = exportSession(db, id1, 'md', { mask: false, locale: 'en' })
    expect(raw.text).toContain('API_KEY=abcdef1234567')
    const html = exportSession(db, id1, 'html', { mask: true, locale: 'en' })
    expect(html.text.startsWith('<!doctype html>')).toBe(true)
    expect(html.text).not.toContain('<script')
  })

  it('escapes transcript text in HTML', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const f = path.join(sb.projectRoot, `${S1}.jsonl`)
    writeLines(f, [userLine('u1', '<img src=x onerror=alert(1)>')])
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: f })
    const sid = (db.prepare(`SELECT id FROM sessions`).get() as { id: number }).id
    const html = exportSession(db, sid, 'html', { mask: false, locale: 'en' }).text
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
  })

  it('builds a handoff prompt from my prompts, files and the last reply', async () => {
    const { db, id1, sb, pid } = await seed()
    const f = path.join(sb.projectRoot, `${S1}.jsonl`)
    fs.appendFileSync(
      f,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'a9',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' } }] },
      })}\n`,
    )
    const t = new Date(Date.now() + 2000)
    fs.utimesSync(f, t, t)
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: f })
    const h = handoffPrompt(db, id1, { mask: true, locale: 'en' })
    expect(h.text).toContain('Title: My renamed session')
    expect(h.text).toContain('1. fix the build error')
    expect(h.text).toContain('2. now add tests')
    expect(h.text).toContain('/work/app/src/a.ts')
    expect(h.text).toContain('API_KEY=••••')
    expect(summarizeToolUse('Edit', { file_path: 'x' })).toContain('[도구] Edit')
  })
})

describe('search paging and operators', () => {
  it('pages FTS results without falling back to substring matches', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const f = path.join(sb.projectRoot, `${S1}.jsonl`)
    writeLines(f, Array.from({ length: 30 }, (_, i) => userLine(`u${i}`, `widget number ${i}`)))
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: f })
    const page = (offset: number) => unifiedSearch(db, { query: 'widget', limit: 20, offset, sort: 'oldest' })
    const a = page(0)
    const b = page(20)
    const c = page(40)
    expect(a).toHaveLength(20)
    expect(b).toHaveLength(10)
    expect(c).toHaveLength(0)
    const ids = new Set([...a, ...b].map((h) => (h.hitType === 'message' ? h.messageId : 0)))
    expect(ids.size).toBe(30)
  })

  it('filters by project text, branch, archive state and session; supports regex', async () => {
    const { db, f2, id1 } = await seed()
    const q = (extra: object) =>
      unifiedSearch(db, { query: 'session', excludeTools: false, ...extra }).map((h) => (h.hitType === 'message' ? h.sessionId : 0))
    expect(q({ projectQuery: 'WORK/APP' }).length).toBeGreaterThan(0)
    expect(q({ projectQuery: 'nope' })).toEqual([])
    const branch = unifiedSearch(db, { query: 'tests', branch: 'feat' })
    expect(branch).toHaveLength(1)
    expect(unifiedSearch(db, { query: 'tests', branch: 'main' })).toHaveLength(0)
    handleSessionUnlink(db, f2, 'keep')
    expect(unifiedSearch(db, { query: 'second', archived: 'archived' })).toHaveLength(1)
    expect(unifiedSearch(db, { query: 'second', archived: 'live' })).toHaveLength(0)
    expect(unifiedSearch(db, { query: '', sessionId: id1 }).length).toBeGreaterThan(0)
    const rx = unifiedSearch(db, { query: '', regex: 'build\\s+ERROR', regexFlags: 'i' })
    expect(rx).toHaveLength(1)
    expect(rx[0].hitType === 'message' && rx[0].snippet).toContain('«build error»')
    expect(unifiedSearch(db, { query: '', regex: '(' })).toEqual([])
  })
})

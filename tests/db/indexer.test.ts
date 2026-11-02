import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { indexAdapterProject, indexSessionFile, reconcileMissing, handleSessionUnlink } from '../../electron/indexer'
import { requestFullReparse, setSetting } from '../../electron/db'
import {
  addFavorite,
  listFavorites,
  listPrompts,
  purgeArchived,
  recentSessions,
  setMessageTags,
  createTag,
  sessionTranscript,
} from '../../electron/queries'
import { computeStats } from '../../electron/stats'
import { unifiedSearch } from '../../electron/search'
import { appendLines, assistantLine, metaLine, sandbox, toolResultLine, userLine, writeLines } from './helpers'

const idsOf = (db: ReturnType<ReturnType<typeof sandbox>['open']>, sessionFile: string) =>
  (
    db
      .prepare(`SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.file_path = ? ORDER BY line_index`)
      .all(sessionFile) as { id: number }[]
  ).map((r) => r.id)

describe('append-only indexing', () => {
  it('resumes a grown file from the last offset and keeps existing rows', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 's1.jsonl')
    writeLines(file, [userLine('u1', 'first prompt'), assistantLine('a1', 'first answer')])

    const first = await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    expect(first).toEqual({ added: 2, mode: 'full' })
    const before = idsOf(db, file)

    appendLines(file, [userLine('u2', 'second prompt')])
    const second = await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    expect(second).toEqual({ added: 1, mode: 'append' })
    const after = idsOf(db, file)
    expect(after.slice(0, 2)).toEqual(before)
    expect(after).toHaveLength(3)

    const unchanged = await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    expect(unchanged.mode).toBe('skip')
  })

  it('does not consume a half-written trailing line until it is complete', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 's1.jsonl')
    const full = userLine('u2', 'second')
    fs.writeFileSync(file, `${userLine('u1', 'first')}\n${full.slice(0, 20)}`)
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    expect(idsOf(db, file)).toHaveLength(1)

    fs.appendFileSync(file, `${full.slice(20)}\n`)
    const t = new Date(Date.now() + 2000)
    fs.utimesSync(file, t, t)
    const res = await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    expect(res.mode).toBe('append')
    const rows = sessionTranscript(db, (db.prepare(`SELECT id FROM sessions`).get() as { id: number }).id)
    expect(rows.map((r) => r.body)).toEqual(['first', 'second'])
  })

  it('re-reads a rewritten file but keeps favorites and tags (keyed by uuid)', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 's1.jsonl')
    writeLines(file, [userLine('u1', 'keep me'), assistantLine('a1', 'answer')])
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })

    const msgId = idsOf(db, file)[0]
    addFavorite(db, msgId)
    const tag = createTag(db, 'important', null)
    setMessageTags(db, 'u1', [tag])

    // Same lines, different bytes at the start → fingerprint mismatch → full re-read.
    writeLines(file, [metaLine('title'), userLine('u1', 'keep me'), assistantLine('a1', 'answer')])
    const res = await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    expect(res.mode).toBe('full')
    expect(idsOf(db, file)).not.toContain(msgId)

    const [fav] = listFavorites(db)
    expect(fav.msgKey).toBe('u1')
    expect(fav.messageId).not.toBeNull()
    expect(fav.archived).toBe(false)
    expect(fav.tagIds).toEqual([tag])
  })
})

describe('archive vs mirror when Claude Code deletes a transcript', () => {
  it('keeps rows as archived by default, and the favorite stays reachable', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 'old.jsonl')
    writeLines(file, [userLine('u1', 'an old conversation about vaults')])
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    addFavorite(db, idsOf(db, file)[0])

    fs.rmSync(file)
    expect(reconcileMissing(db, sb.adapter, 'keep')).toBe(1)
    const s = db.prepare(`SELECT archived_at FROM sessions`).get() as { archived_at: number | null }
    expect(s.archived_at).not.toBeNull()
    const hits = unifiedSearch(db, { query: 'vaults' })
    expect(hits).toHaveLength(1)
    expect(hits[0].hitType === 'message' && hits[0].archived).toBe(true)
    expect(listFavorites(db)[0].archived).toBe(true)
  })

  it('mirror mode deletes the rows but the favorite keeps its snapshot', async () => {
    const sb = sandbox()
    const db = sb.open()
    setSetting(db, 'archiveMode', 'mirror')
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 'old.jsonl')
    writeLines(file, [userLine('u1', 'snapshot body')])
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    addFavorite(db, idsOf(db, file)[0])

    fs.rmSync(file)
    expect(handleSessionUnlink(db, file, 'mirror')).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get()).toEqual({ c: 0 })
    const [fav] = listFavorites(db)
    expect(fav.body).toBe('snapshot body')
    expect(fav.messageId).toBeNull()
  })

  it('treats a missing source root as "unavailable", never as "everything was deleted"', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 's.jsonl')
    writeLines(file, [userLine('u1', 'x')])
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    fs.rmSync(sb.projectsRoot, { recursive: true })
    expect(reconcileMissing(db, sb.adapter, 'mirror')).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get()).toEqual({ c: 1 })
  })
})

describe('a file that comes back different never replaces what the vault holds', () => {
  type Row = { id: number; filePath: string; relPath: string; archivedAt: number | null; messageCount: number }

  async function indexed(lines: string[]) {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 's1.jsonl')
    writeLines(file, lines)
    const index = (appendable = true) =>
      indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file, appendable })
    await index()
    const sessions = () =>
      db
        .prepare(
          `SELECT id, file_path AS filePath, rel_path AS relPath, archived_at AS archivedAt, message_count AS messageCount
           FROM sessions ORDER BY id`,
        )
        .all() as Row[]
    const bodies = (sessionId: number) => sessionTranscript(db, sessionId).map((r) => r.body)
    const ftsOk = () => db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
    return { sb, db, pid, file, index, sessions, bodies, ftsOk }
  }

  const ORIGINAL = [userLine('u1', 'sentinelold question'), assistantLine('a1', 'sentinelold answer')]
  const REPLACEMENT = [userLine('n1', 'brandnew question')]

  it('a file reappearing at an archived path keeps the archive and indexes as its own session', async () => {
    const { db, file, index, sessions, bodies, ftsOk } = await indexed(ORIGINAL)
    const [before] = sessions()
    const keptIds = idsOf(db, file)
    fs.rmSync(file)
    handleSessionUnlink(db, file, 'keep')

    writeLines(file, REPLACEMENT)
    const res = await index()
    expect(res).toEqual({ added: 1, mode: 'full' })

    const rows = sessions()
    expect(rows).toHaveLength(2)
    const archived = rows.find((r) => r.archivedAt != null)!
    const live = rows.find((r) => r.archivedAt == null)!
    expect(archived.filePath).toMatch(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#archived-\\d+$`))
    expect(archived.relPath).toMatch(/^s1\.jsonl#archived-\d+$/)
    expect(archived.messageCount).toBe(2)
    expect(bodies(archived.id)).toEqual(['sentinelold question', 'sentinelold answer'])
    expect(live.filePath).toBe(file)
    expect(bodies(live.id)).toEqual(['brandnew question'])
    expect(live.id).not.toBe(before.id)

    const hits = unifiedSearch(db, { query: 'sentinelold' })
    expect(hits).toHaveLength(2)
    expect(hits.every((h) => h.hitType === 'message' && h.archived)).toBe(true)
    expect(unifiedSearch(db, { query: 'brandnew' })).toHaveLength(1)
    // Rows stay where they were: ids, and so FTS, are untouched.
    expect(db.prepare(`SELECT id FROM messages WHERE session_id = ? ORDER BY line_index`).all(archived.id)).toEqual(
      keptIds.map((id) => ({ id })),
    )
    ftsOk()
  })

  it('a rewrite of a live session in keep mode archives the old rows', async () => {
    const { db, file, index, sessions, bodies, ftsOk } = await indexed(ORIGINAL)
    writeLines(file, [userLine('n1', 'brandnew question that is a different length')])
    expect((await index()).mode).toBe('full')

    const rows = sessions()
    expect(rows).toHaveLength(2)
    const archived = rows.find((r) => r.archivedAt != null)!
    expect(archived.filePath).toContain('#archived-')
    expect(bodies(archived.id)).toEqual(['sentinelold question', 'sentinelold answer'])
    expect(bodies(rows.find((r) => r.archivedAt == null)!.id)).toEqual(['brandnew question that is a different length'])
    expect(unifiedSearch(db, { query: 'sentinelold' })).toHaveLength(2)
    ftsOk()
  })

  it('a shrink of a live session in keep mode archives the old rows', async () => {
    const { db, file, index, sessions, bodies } = await indexed(ORIGINAL)
    writeLines(file, [userLine('u1', 'sentinelold question')])
    expect((await index()).mode).toBe('full')

    const rows = sessions()
    expect(rows).toHaveLength(2)
    expect(bodies(rows.find((r) => r.archivedAt != null)!.id)).toEqual(['sentinelold question', 'sentinelold answer'])
    expect(bodies(rows.find((r) => r.archivedAt == null)!.id)).toEqual(['sentinelold question'])
    expect(unifiedSearch(db, { query: 'answer' })).toHaveLength(1)
  })

  it('an archived session whose file returns grown is revived and appended to', async () => {
    const { db, file, index, sessions, bodies } = await indexed(ORIGINAL)
    const [before] = sessions()
    const keptIds = idsOf(db, file)
    const content = fs.readFileSync(file)
    fs.rmSync(file)
    handleSessionUnlink(db, file, 'keep')
    expect(sessions()[0].archivedAt).not.toBeNull()

    fs.writeFileSync(file, content)
    appendLines(file, [userLine('u2', 'one more')])
    expect(await index()).toEqual({ added: 1, mode: 'append' })

    const rows = sessions()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(before.id)
    expect(rows[0].archivedAt).toBeNull()
    expect(rows[0].filePath).toBe(file)
    expect(bodies(before.id)).toEqual(['sentinelold question', 'sentinelold answer', 'one more'])
    expect(idsOf(db, file).slice(0, 2)).toEqual(keptIds)
  })

  it('an archived session whose file returns unchanged is revived without a re-read', async () => {
    const { db, file, index, sessions } = await indexed(ORIGINAL)
    const [before] = sessions()
    const content = fs.readFileSync(file)
    const stat = fs.statSync(file)
    fs.rmSync(file)
    handleSessionUnlink(db, file, 'keep')
    expect(sessions()[0].archivedAt).not.toBeNull()
    fs.writeFileSync(file, content)
    fs.utimesSync(file, stat.atime, stat.mtime)
    expect((await index()).mode).toBe('skip')
    expect(sessions()).toEqual([before])
  })

  it('an archived file back with the same size and mtime but other bytes is still not trusted', async () => {
    const { db, file, index, sessions, bodies } = await indexed([userLine('u1', 'sentinelold aaaa')])
    const stat = fs.statSync(file)
    const before = sessions()[0]
    fs.rmSync(file)
    handleSessionUnlink(db, file, 'keep')
    // Same length, same mtime: only the fingerprint can tell these apart.
    writeLines(file, [userLine('u9', 'sentinelnew bbbb')])
    expect(fs.statSync(file).size).toBe(stat.size)
    fs.utimesSync(file, stat.atime, stat.mtime)

    await index()
    const rows = sessions()
    expect(rows).toHaveLength(2)
    expect(bodies(before.id)).toEqual(['sentinelold aaaa'])
    expect(bodies(rows.find((r) => r.archivedAt == null)!.id)).toEqual(['sentinelnew bbbb'])
  })

  it('rows reset by requestFullReparse are re-read in place', async () => {
    const { db, file, index, sessions, bodies } = await indexed(ORIGINAL)
    const [before] = sessions()
    requestFullReparse(db)
    writeLines(file, REPLACEMENT)
    expect((await index()).mode).toBe('full')
    expect(sessions().map((r) => r.id)).toEqual([before.id])
    expect(bodies(before.id)).toEqual(['brandnew question'])
  })

  it('mirror mode still replaces a live session, but never an archived one', async () => {
    const { db, file, index, sessions, bodies } = await indexed(ORIGINAL)
    const [before] = sessions()
    setSetting(db, 'archiveMode', 'mirror')
    writeLines(file, REPLACEMENT)
    expect((await index()).mode).toBe('full')
    expect(sessions().map((r) => r.id)).toEqual([before.id])
    expect(bodies(before.id)).toEqual(['brandnew question'])

    // Archived while the setting was Keep; "Delete too" only applies to later deletions.
    setSetting(db, 'archiveMode', 'keep')
    fs.rmSync(file)
    handleSessionUnlink(db, file, 'keep')
    setSetting(db, 'archiveMode', 'mirror')
    writeLines(file, [userLine('n2', 'second replacement, longer than the first one')])
    await index()
    const rows = sessions()
    expect(rows).toHaveLength(2)
    expect(bodies(before.id)).toEqual(['brandnew question'])
    expect(rows.find((r) => r.id === before.id)!.filePath).toContain('#archived-')
  })

  it('a stateful format that only grew is re-read in place; a rewrite is not', async () => {
    const { file, index, sessions, bodies } = await indexed(ORIGINAL)
    const [before] = sessions()
    appendLines(file, [userLine('u2', 'one more')])
    expect((await index(false)).mode).toBe('full')
    expect(sessions().map((r) => r.id)).toEqual([before.id])
    expect(bodies(before.id)).toEqual(['sentinelold question', 'sentinelold answer', 'one more'])

    writeLines(file, REPLACEMENT)
    await index(false)
    expect(sessions()).toHaveLength(2)
    expect(bodies(before.id)).toEqual(['sentinelold question', 'sentinelold answer', 'one more'])
  })

  it('a session with no rows has nothing to keep', async () => {
    const { file, index, sessions } = await indexed(['   '])
    const [before] = sessions()
    expect(before.messageCount).toBe(0)
    writeLines(file, REPLACEMENT)
    await index()
    expect(sessions().map((r) => r.id)).toEqual([before.id])
    expect(sessions()[0].messageCount).toBe(1)
  })

  it('never reuses a suffix, keeps each generation, and purges them all on request', async () => {
    const { db, file, index, sessions, bodies } = await indexed(ORIGINAL)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 1))
    try {
      writeLines(file, [userLine('g1', 'generation one, a different length')])
      await index()
      writeLines(file, [userLine('g2', 'generation two, also a different length again')])
      await index()
    } finally {
      now.mockRestore()
    }
    const rows = sessions()
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.filePath)).size).toBe(3)
    expect(rows.filter((r) => r.archivedAt != null).flatMap((r) => bodies(r.id))).toEqual([
      'sentinelold question',
      'sentinelold answer',
      'generation one, a different length',
    ])

    expect(purgeArchived(db)).toBe(2)
    expect(sessions().map((r) => r.filePath)).toEqual([file])
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
  })

  it('reconcile and unlink leave archived generations alone', async () => {
    const { sb, db, file, index, sessions } = await indexed(ORIGINAL)
    writeLines(file, REPLACEMENT)
    await index()
    const archived = sessions().find((r) => r.archivedAt != null)!

    fs.rmSync(file)
    expect(reconcileMissing(db, sb.adapter, 'mirror')).toBe(1)
    const rows = sessions()
    expect(rows).toEqual([archived])
  })

  it('a deletion event does not touch a row already archived, in either mode', async () => {
    const { db, file, sessions } = await indexed(ORIGINAL)
    fs.rmSync(file)
    handleSessionUnlink(db, file, 'keep')
    const [archived] = sessions()

    // A file that appeared and vanished before it was indexed, after a switch to mirror.
    expect(handleSessionUnlink(db, file, 'mirror')).toBe(false)
    expect(handleSessionUnlink(db, file, 'keep')).toBe(false)
    expect(sessions()).toEqual([archived])
  })

  it('favorites and tags follow msg_key across generations', async () => {
    const { db, file, index, sessions } = await indexed(ORIGINAL)
    addFavorite(db, idsOf(db, file)[0])
    addFavorite(db, idsOf(db, file)[1])
    const tag = createTag(db, 'important', null)
    setMessageTags(db, 'u1', [tag])

    // u1 is still in the new file; a1 is gone from it.
    writeLines(file, [userLine('u1', 'sentinelold question'), userLine('n1', 'brandnew question')])
    await index()
    expect(sessions()).toHaveLength(2)

    const favs = listFavorites(db)
    const u1 = favs.find((f) => f.msgKey === 'u1')!
    const a1 = favs.find((f) => f.msgKey === 'a1')!
    expect(u1.archived).toBe(false)
    expect(u1.tagIds).toEqual([tag])
    // The line exists only in the kept generation, and it is still reachable there.
    expect(a1.archived).toBe(true)
    expect(a1.messageId).not.toBeNull()
  })
})

describe('stats', () => {
  it('counts a response once even though usage repeats on each of its lines', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 's.jsonl')
    writeLines(file, [
      userLine('u1', 'go'),
      // One API response split over three lines; output grows as it streams.
      assistantLine('a1', 'thinking…', { msgId: 'msg_1', output: 1 }),
      assistantLine('a2', 'part one', { msgId: 'msg_1', output: 3 }),
      assistantLine('a3', 'part two', { msgId: 'msg_1', output: 7 }),
      assistantLine('a4', 'next turn', { msgId: 'msg_2', requestId: 'req_2', output: 2 }),
    ])
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    const stats = computeStats(db)
    expect(stats.tokensByModel).toHaveLength(1)
    const m = stats.tokensByModel[0]
    expect(m.messages).toBe(2)
    expect(m.output).toBe(7 + 2)
    expect(m.input).toBe(20)
    expect(m.cacheCreation1h).toBe(40)
    expect(stats.totalPrompts).toBe(1)
  })
})

describe('search', () => {
  async function seeded() {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const file = path.join(sb.projectRoot, 's.jsonl')
    writeLines(file, [
      userLine('u1', '재색인 버그를 고쳐줘'),
      assistantLine('a1', 'reindex fixed'),
      toolResultLine('t1', 'reindex log output'),
      metaLine('reindex title'),
    ])
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    return { sb, db, file }
  }

  it('keeps bookkeeping lines out of the full-text index', async () => {
    const { db } = await seeded()
    const ftsRows = db.prepare(`SELECT COUNT(*) AS c FROM messages_fts`).get() as { c: number }
    const nonMeta = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE message_class != 'meta'`).get() as { c: number }
    expect(ftsRows.c).toBe(nonMeta.c)
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
    const hits = unifiedSearch(db, { query: 'reindex' })
    expect(hits.every((h) => h.hitType === 'message' && h.messageClass !== 'meta')).toBe(true)
    const withMeta = unifiedSearch(db, { query: 'reindex', excludeMeta: false })
    expect(withMeta.length).toBe(hits.length + 1)
  })

  it('finds a word inside a longer word via the substring fallback', async () => {
    const { db } = await seeded()
    const hits = unifiedSearch(db, { query: '색인' })
    expect(hits).toHaveLength(1)
  })

  it('filters by tag (and lists everything tagged when the query is empty) and can exclude tool output', async () => {
    const { db } = await seeded()
    const tag = createTag(db, 't', null)
    setMessageTags(db, 'a1', [tag])
    expect(unifiedSearch(db, { query: 'reindex', tagId: tag })).toHaveLength(1)
    expect(unifiedSearch(db, { query: '', tagId: tag })).toHaveLength(1)
    const all = unifiedSearch(db, { query: 'reindex' })
    const noTools = unifiedSearch(db, { query: 'reindex', excludeTools: true })
    expect(noTools.length).toBe(all.length - 1)
  })

  it('stays consistent through repeated re-reads (FTS integrity)', async () => {
    const { sb, db, file } = await seeded()
    // Mirror replaces rows on a rewrite; Keep holds on to them, so each round would add hits.
    setSetting(db, 'archiveMode', 'mirror')
    const pid = sb.project(db)
    for (let i = 0; i < 3; i += 1) {
      writeLines(file, [metaLine(`t${i}`), userLine('u1', `round ${i}`), assistantLine('a1', 'reindex')])
      await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    }
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
    expect(unifiedSearch(db, { query: 'reindex' })).toHaveLength(1)
  })
})

describe('prompts', () => {
  it('groups identical prompts and counts distinct uses', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    writeLines(path.join(sb.projectRoot, 'a.jsonl'), [userLine('u1', 'run the tests', '2026-10-01T00:00:00Z')])
    writeLines(path.join(sb.projectRoot, 'b.jsonl'), [
      userLine('u2', 'run the tests', '2026-10-02T00:00:00Z'),
      userLine('u3', 'ship it', '2026-10-03T00:00:00Z'),
      // A forked session copies an earlier line with the same uuid: not a new use.
      userLine('u2', 'run the tests', '2026-10-02T00:00:00Z'),
    ])
    for (const f of ['a.jsonl', 'b.jsonl']) {
      await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: path.join(sb.projectRoot, f) })
    }
    const recent = listPrompts(db, { query: '', sort: 'recent' })
    expect(recent.map((p) => p.text)).toEqual(['ship it', 'run the tests'])
    const frequent = listPrompts(db, { query: '', sort: 'frequent' })
    expect(frequent[0]).toMatchObject({ text: 'run the tests', uses: 2 })
    expect(listPrompts(db, { query: 'tests' })).toHaveLength(1)
  })
})

describe('project titles', () => {
  it('replaces a slug guess with the cwd the transcripts recorded, and keeps it on later scans', async () => {
    const sb = sandbox()
    const db = sb.open()
    writeLines(path.join(sb.projectRoot, 's.jsonl'), [
      JSON.stringify({ type: 'user', uuid: 'u1', cwd: '/Volumes/disk/my-app', message: { role: 'user', content: 'hi' } }),
    ])
    const project = { slug: '-Volumes-disk-my-app', root: sb.projectRoot, displayName: '-Volumes-disk-my-app', displayNameIsGuess: true }
    const title = () => (db.prepare(`SELECT display_name FROM projects`).get() as { display_name: string }).display_name
    await indexAdapterProject(db, sb.adapter, project)
    expect(title()).toBe('/Volumes/disk/my-app')
    await indexAdapterProject(db, sb.adapter, project)
    expect(title()).toBe('/Volumes/disk/my-app')
  })
})

describe('recent sessions', () => {
  it('lists sessions people opened, not their subagent transcripts', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const main = path.join(sb.projectRoot, 'main.jsonl')
    const sub = path.join(sb.projectRoot, 'main', 'subagents', 'agent-1.jsonl')
    fs.mkdirSync(path.dirname(sub), { recursive: true })
    writeLines(main, [userLine('u1', 'top-level prompt')])
    writeLines(sub, [userLine('s1', 'subagent task', '2026-10-02T00:00:00Z')])
    for (const f of [main, sub]) await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: f })
    const rows = recentSessions(db, null)
    expect(rows.map((r) => r.sessionFile)).toEqual(['main.jsonl'])
    expect(rows[0].preview).toBe('top-level prompt')
  })
})

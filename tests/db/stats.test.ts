import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { indexSessionFile, upsertProject } from '../../electron/indexer'
import { computeStats, localDay, usageBlocks } from '../../electron/stats'
import { sandbox, toolResultLine, userLine, writeLines } from './helpers'

const HOUR = 3_600_000

/** One line of an API response at `ts`, with `content` as its blocks. */
const response = (
  uuid: string,
  opts: { msgId: string; ts: number; output?: number; content?: unknown[]; model?: string },
) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    requestId: `req_${opts.msgId}`,
    timestamp: new Date(opts.ts).toISOString(),
    message: {
      id: opts.msgId,
      role: 'assistant',
      model: opts.model ?? 'claude-opus-5-5',
      content: opts.content ?? [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: opts.output ?? 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    },
  })

const toolUse = (name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id: `t_${name}`, name, input })

describe('stats: usage by project', () => {
  it('counts a response once, in the project that holds it first', async () => {
    const sb = sandbox()
    const db = sb.open()
    const a = sb.project(db)
    const otherRoot = path.join(sb.projectsRoot, '-work-other')
    fs.mkdirSync(otherRoot)
    const b = upsertProject(db, { slug: '-work-other', root: otherRoot, displayName: '/work/other' }, 'claude')
    const t0 = Date.UTC(2026, 9, 1, 10, 0)

    const shared = [
      response('a1', { msgId: 'msg_1', ts: t0, output: 2 }),
      response('a2', { msgId: 'msg_1', ts: t0 + 1000, output: 9 }),
    ]
    const fileA = path.join(sb.projectRoot, 'a.jsonl')
    writeLines(fileA, [userLine('u1', 'go'), ...shared, response('a3', { msgId: 'msg_2', ts: t0 + 60_000, model: 'claude-haiku-4-5' })])
    await indexSessionFile(db, { projectId: a, projectRoot: sb.projectRoot, filePath: fileA })
    // A copy of the same response under different line uuids (another tool's mirror of it).
    const fileB = path.join(otherRoot, 'b.jsonl')
    writeLines(fileB, [
      response('b1', { msgId: 'msg_1', ts: t0, output: 9 }),
      response('b2', { msgId: 'msg_9', ts: t0 + 120_000, output: 4 }),
    ])
    await indexSessionFile(db, { projectId: b, projectRoot: otherRoot, filePath: fileB })

    const rows = computeStats(db).tokensByProject
    const pa = rows.find((r) => r.projectId === a)!
    const pb = rows.find((r) => r.projectId === b)!
    expect(pa).toMatchObject({ projectName: '/work/app', sessions: 1, responses: 2, input: 20, output: 9 + 5, cacheRead: 200 })
    expect(pa.byModel.map((m) => [m.model, m.messages])).toEqual([
      ['claude-opus-5-5', 1],
      ['claude-haiku-4-5', 1],
    ])
    expect(pb).toMatchObject({ responses: 1, output: 4 })
    // The project totals add up to the per-model totals: nothing counted twice.
    const stats = computeStats(db)
    const byModel = stats.tokensByModel.reduce((n, m) => n + m.messages, 0)
    expect(rows.reduce((n, r) => n + r.responses, 0)).toBe(byModel)
  })
})

describe('stats: tool usage', () => {
  it('counts each call by name and matches results to calls for the error rate', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const t0 = Date.UTC(2026, 9, 1, 10, 0)
    const lines = [
      userLine('u1', 'fix it'),
      response('c1', { msgId: 'm1', ts: t0, content: [toolUse('Bash', { command: 'npm test' })] }),
      toolResultLine('r1', 'Exit code 1\nFAIL tests'),
      // Two parallel calls in one line, answered in order.
      response('c2', { msgId: 'm2', ts: t0 + 1000, content: [toolUse('Read', { file_path: '/a' }), toolUse('Bash', { command: 'ls' })] }),
      toolResultLine('r2', '<tool_use_error>File does not exist.</tool_use_error>'),
      toolResultLine('r3', 'a.ts\nb.ts'),
      response('c3', { msgId: 'm3', ts: t0 + 2000, content: [toolUse('Read', { file_path: '/b' })] }),
      toolResultLine('r4', 'line one'),
    ]
    const file = path.join(sb.projectRoot, 's.jsonl')
    writeLines(file, lines)
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    // A forked session repeats the same lines: they must not count again.
    const fork = path.join(sb.projectRoot, 'fork.jsonl')
    writeLines(fork, lines)
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: fork })

    expect(computeStats(db).toolUsage).toEqual([
      { tool: 'Bash', calls: 2, errors: 1 },
      { tool: 'Read', calls: 2, errors: 1 },
    ])
  })

  it('reads tool rows through the partial index', () => {
    const sb = sandbox()
    const db = sb.open()
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT session_id FROM messages INDEXED BY idx_messages_tool
         WHERE role = 'tool' OR content_kinds LIKE '%"tool_use"%' ORDER BY session_id, line_index`,
      )
      .all() as { detail: string }[]
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_messages_tool')
    expect(plan.map((p) => p.detail).join(' ')).not.toContain('TEMP B-TREE')
  })
})

describe('stats: 5-hour blocks', () => {
  it('opens a block at the hour of the first response after the last one closed', () => {
    const t0 = Date.UTC(2026, 9, 1, 10, 17)
    const at = (ms: number) => ({ ts: ms, input: 1, output: 2, cacheRead: 0, cacheCreation: 0 })
    const blocks = usageBlocks([
      at(t0),
      at(Date.UTC(2026, 9, 1, 12)),
      at(Date.UTC(2026, 9, 1, 14, 59)),
      at(Date.UTC(2026, 9, 1, 15)), // the first block ends at 15:00 sharp
      at(Date.UTC(2026, 9, 1, 21, 30)),
    ])
    expect(blocks.map((b) => [new Date(b.startMs).toISOString(), (b.endMs - b.startMs) / HOUR, b.responses, b.output])).toEqual([
      ['2026-10-01T10:00:00.000Z', 5, 3, 6],
      ['2026-10-01T15:00:00.000Z', 5, 1, 2],
      ['2026-10-01T21:00:00.000Z', 5, 1, 2],
    ])
  })

  it('keeps the last ten blocks, built from deduplicated responses', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const t0 = Date.UTC(2026, 9, 1, 0, 30)
    const lines: string[] = []
    for (let i = 0; i < 12; i++) {
      // Each response written over two lines, as Claude Code does.
      lines.push(response(`x${i}a`, { msgId: `m${i}`, ts: t0 + i * 6 * HOUR, output: 1 }))
      lines.push(response(`x${i}b`, { msgId: `m${i}`, ts: t0 + i * 6 * HOUR + 500, output: 3 }))
    }
    const file = path.join(sb.projectRoot, 's.jsonl')
    writeLines(file, lines)
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    const blocks = computeStats(db).usageBlocks
    expect(blocks).toHaveLength(10)
    expect(blocks[0].startMs).toBe(Date.UTC(2026, 9, 1, 12))
    expect(blocks.every((b) => b.responses === 1 && b.output === 3 && b.input === 10)).toBe(true)
  })
})

describe('stats: activity heatmaps', () => {
  it('buckets prompts by local day, weekday and hour', async () => {
    const sb = sandbox()
    const db = sb.open()
    const pid = sb.project(db)
    const late = new Date(2026, 9, 1, 23, 30) // local time
    const early = new Date(2026, 9, 2, 0, 30)
    const old = new Date(2025, 0, 1, 9, 0) // before the 53-week grid
    const lines = [
      userLine('p1', 'one', late.toISOString()),
      userLine('p2', 'two', new Date(late.getTime() + 60_000).toISOString()),
      userLine('p3', 'three', early.toISOString()),
      userLine('p4', 'four', old.toISOString()),
    ]
    const file = path.join(sb.projectRoot, 's.jsonl')
    writeLines(file, lines)
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: file })
    const fork = path.join(sb.projectRoot, 'fork.jsonl')
    writeLines(fork, lines)
    await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: fork })

    const stats = computeStats(db, new Date(2026, 9, 10, 12))
    expect(stats.activityYear).toEqual([
      { day: '2026-10-01', count: 2 },
      { day: '2026-10-02', count: 1 },
    ])
    expect(localDay(late.getTime())).toBe('2026-10-01')
    const cell = (d: Date) => stats.activityByHour.find((c) => c.weekday === d.getDay() && c.hour === d.getHours())?.count
    expect(cell(late)).toBe(2)
    expect(cell(early)).toBe(1)
    expect(cell(old)).toBe(1)
    expect(stats.activityByHour.reduce((n, c) => n + c.count, 0)).toBe(4)
  })
})

import type { DbHandle } from './db.js'
import type { ModelTokenRow, ProjectUsageRow, StatsPayload, ToolUsageRow, UsageBlock } from '../shared/ipc.js'

const STOP = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'is',
  'it',
  'in',
  'for',
  'on',
  'with',
  '가',
  '을',
  '를',
  '이',
  '은',
  '는',
  '에',
  '의',
  '로',
  '하고',
  '해줘',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9가-힣_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP.has(t))
}

/**
 * One row per API response. Claude Code writes a line per content block and repeats
 * `usage` on each (later lines carry the final, larger `output_tokens`), so summing
 * lines double-counts ~2×. Group by response identity and take each field's max;
 * lines without an id count once per `msg_key`, the same line in another session being
 * the same usage.
 */
const RESPONSES_SQL = `
  SELECT MAX(model) AS model,
         MAX(COALESCE(input_tokens, 0)) AS input,
         MAX(COALESCE(output_tokens, 0)) AS output,
         MAX(COALESCE(cache_read_tokens, 0)) AS cacheRead,
         MAX(COALESCE(cache_creation_tokens, 0)) AS cacheCreation,
         MAX(COALESCE(cache_creation_1h_tokens, 0)) AS cacheCreation1h
  FROM messages
  -- Every usage record carries input_tokens; matching the predicate of the partial
  -- idx_messages_usage_cover lets SQLite read these from that index, and go to the row
  -- only for the msg_key of a line with no id.
  WHERE input_tokens IS NOT NULL
  GROUP BY CASE WHEN api_msg_id IS NOT NULL THEN api_msg_id || ':' || COALESCE(request_id, '')
                ELSE 'key:' || msg_key END
`

/**
 * A line can have several rows: a forked session copies earlier lines, and a rewritten file
 * leaves them in an archived generation too. Stats count lines, so everything here counts
 * distinct `msg_key`s, as `listPrompts` does. Prompts are read through their partial index;
 * left to itself SQLite walks idx_messages_key and reads every row to find them (~730 ms on
 * 750k rows, against ~10 ms).
 */
const PROMPTS = `messages INDEXED BY idx_messages_prompt`

/**
 * Role counts come from idx_messages_class_role, without reading ~700k wide rows for their
 * `msg_key`; the rows of lines held more than once are then taken back off. Finding those
 * needs only idx_messages_key.
 */
const ROLES_SQL = `
  SELECT role, SUM(count) AS count FROM (
    SELECT role, COUNT(*) AS count FROM messages WHERE message_class != 'meta' GROUP BY role
    UNION ALL
    SELECT m.role, COUNT(DISTINCT m.msg_key) - COUNT(*)
    FROM (SELECT msg_key FROM messages GROUP BY msg_key HAVING COUNT(*) > 1) AS repeated
    JOIN messages m ON m.msg_key = repeated.msg_key
    WHERE m.message_class != 'meta'
    GROUP BY m.role
  )
  GROUP BY role
  ORDER BY count DESC, role
`

/** Local `YYYY-MM-DD` of a timestamp, the same day key `activityByDay` uses. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** First day (a Sunday, local midnight) of the 53-week grid that ends with the week of `now`. */
export function yearGridStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - 52 * 7)
}

/**
 * Prompts per local day for the year grid and per weekday × hour, in one pass over the prompt
 * lines. Local time is taken in JS: SQLite's `localtime` has no cheap weekday/hour pair and
 * leans on the C library's idea of the zone.
 */
function promptActivity(db: DbHandle, now: Date): Pick<StatsPayload, 'activityYear' | 'activityByHour'> {
  const from = yearGridStart(now).getTime()
  const byDay = new Map<string, number>()
  const byHour = new Array<number>(7 * 24).fill(0)
  for (const { ts } of db
    .prepare(`SELECT MIN(ts_ms) AS ts FROM ${PROMPTS} WHERE is_prompt = 1 AND ts_ms IS NOT NULL GROUP BY msg_key`)
    .iterate() as Iterable<{ ts: number }>) {
    const d = new Date(ts)
    byHour[d.getDay() * 24 + d.getHours()]++
    if (ts >= from) {
      const key = localDay(ts)
      byDay.set(key, (byDay.get(key) ?? 0) + 1)
    }
  }
  return {
    activityYear: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, count]) => ({ day, count })),
    activityByHour: byHour.flatMap((count, i) => (count > 0 ? [{ weekday: Math.floor(i / 24), hour: i % 24, count }] : [])),
  }
}

const HOUR_MS = 3_600_000
const BLOCK_MS = 5 * HOUR_MS

type Response = {
  sessionId: number
  ts: number | null
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  cacheCreation1h: number
}

/**
 * Responses grouped as `RESPONSES_SQL` groups them, each with the session (and so the
 * project) and the time it first appears at. A response that a fork copied into another
 * session is still one response, so it goes to one project only: the one holding its
 * lowest session id. Read from the covering idx_messages_usage_where.
 */
const RESPONSES_WHERE_SQL = `
  SELECT MIN(session_id) AS sessionId,
         MIN(ts_ms) AS ts,
         MAX(model) AS model,
         MAX(COALESCE(input_tokens, 0)) AS input,
         MAX(COALESCE(output_tokens, 0)) AS output,
         MAX(COALESCE(cache_read_tokens, 0)) AS cacheRead,
         MAX(COALESCE(cache_creation_tokens, 0)) AS cacheCreation,
         MAX(COALESCE(cache_creation_1h_tokens, 0)) AS cacheCreation1h
  FROM messages INDEXED BY idx_messages_usage_where
  WHERE input_tokens IS NOT NULL
  GROUP BY CASE WHEN api_msg_id IS NOT NULL THEN api_msg_id || ':' || COALESCE(request_id, '')
                ELSE 'key:' || msg_key END
`

/**
 * Claude subscription windows: a block opens at the first response after the previous one
 * closed, floored to the hour, and lasts five hours. `responses` must be in time order;
 * the last `keep` blocks come back, oldest first.
 */
export function usageBlocks(
  responses: Iterable<Pick<Response, 'ts' | 'input' | 'output' | 'cacheRead' | 'cacheCreation'>>,
  keep = 10,
): UsageBlock[] {
  const blocks: UsageBlock[] = []
  let cur: UsageBlock | null = null
  for (const r of responses) {
    if (r.ts == null) continue
    if (!cur || r.ts >= cur.endMs) {
      const startMs = Math.floor(r.ts / HOUR_MS) * HOUR_MS
      cur = { startMs, endMs: startMs + BLOCK_MS, responses: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
      blocks.push(cur)
      if (blocks.length > keep) blocks.shift()
    }
    cur.responses++
    cur.input += r.input
    cur.output += r.output
    cur.cacheRead += r.cacheRead
    cur.cacheCreation += r.cacheCreation
  }
  return blocks
}

type TokenSums = { input: number; output: number; cacheRead: number; cacheCreation: number; cacheCreation1h: number }

function addTokens(to: TokenSums, r: TokenSums) {
  to.input += r.input
  to.output += r.output
  to.cacheRead += r.cacheRead
  to.cacheCreation += r.cacheCreation
  to.cacheCreation1h += r.cacheCreation1h
}

const allTokens = (r: { input: number; output: number; cacheRead: number; cacheCreation: number }) =>
  r.input + r.output + r.cacheRead + r.cacheCreation

/** Usage per project and the 5-hour blocks, from one pass over the responses. */
function responseUsage(db: DbHandle): Pick<StatsPayload, 'tokensByProject' | 'usageBlocks'> {
  const projectOf = new Map<number, number>()
  for (const r of db.prepare(`SELECT id, project_id AS projectId FROM sessions`).iterate() as Iterable<{
    id: number
    projectId: number
  }>) {
    projectOf.set(r.id, r.projectId)
  }
  const projects = new Map<number, ProjectUsageRow & { models: Map<string, ModelTokenRow> }>()
  for (const p of db
    .prepare(
      `SELECT p.id AS projectId, p.display_name AS projectName, COUNT(s.id) AS sessions
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       GROUP BY p.id`,
    )
    .iterate() as Iterable<{ projectId: number; projectName: string; sessions: number }>) {
    projects.set(p.projectId, {
      ...p,
      responses: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      cacheCreation1h: 0,
      byModel: [],
      models: new Map(),
    })
  }

  const timed: Response[] = []
  for (const r of db.prepare(RESPONSES_WHERE_SQL).iterate() as Iterable<Response>) {
    if (r.ts != null) timed.push(r)
    const p = projects.get(projectOf.get(r.sessionId) ?? -1)
    if (!p) continue
    p.responses++
    addTokens(p, r)
    if (!r.model) continue
    let m = p.models.get(r.model)
    if (!m) {
      m = { model: r.model, messages: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 }
      p.models.set(r.model, m)
    }
    m.messages++
    addTokens(m, r)
  }

  const tokensByProject = [...projects.values()]
    .filter((p) => p.responses > 0)
    .sort((a, b) => allTokens(b) - allTokens(a) || b.responses - a.responses)
    .slice(0, 15)
    .map(({ models, ...p }) => ({ ...p, byModel: [...models.values()].sort((a, b) => allTokens(b) - allTokens(a)) }))

  timed.sort((a, b) => (a.ts as number) - (b.ts as number))
  return { tokensByProject, usageBlocks: usageBlocks(timed) }
}

/**
 * Starts of tool result bodies that mark a failed call. The index keeps the result text but
 * not its `is_error` flag, so this is a heuristic: Claude Code wraps rejected calls in
 * `<tool_use_error>` and a failed shell command opens with `Exit code <n>`.
 */
const TOOL_ERROR = /^(<tool_use_error>|[Ee]rror:|Exit code [1-9])/
/** `summarizeToolUse` opens every call with `[도구] <Name>`; a line may hold several calls. */
const TOOL_HEADER = /^\[도구\] ([^\s·]+)/gmu

/**
 * Calls per tool and how many of their results look like errors. Results carry no tool
 * name, so each one is matched to the oldest unanswered call before it in its session
 * (Claude Code answers parallel calls in the order it made them). Only the head of each
 * body is read — a call's first 200 characters, a result's first 60 — so a second call
 * further down one long line goes uncounted; Claude Code writes one call per line. Each
 * line counts once, however many sessions hold it.
 */
function toolUsage(db: DbHandle): ToolUsageRow[] {
  const calls = new Map<string, number>()
  const errors = new Map<string, number>()
  const seen = new Set<string>()
  let session = -1
  let pending: string[] = []
  for (const r of db
    .prepare(
      `SELECT session_id AS sessionId, msg_key AS key, role,
              substr(body, 1, CASE WHEN role = 'tool' THEN 60 ELSE 200 END) AS head
       FROM messages INDEXED BY idx_messages_tool
       WHERE role = 'tool' OR content_kinds LIKE '%"tool_use"%'
       ORDER BY session_id, line_index`,
    )
    .iterate() as Iterable<{ sessionId: number; key: string; role: string; head: string }>) {
    if (r.sessionId !== session) {
      session = r.sessionId
      pending = []
    }
    const fresh = !seen.has(r.key)
    if (fresh) seen.add(r.key)
    if (r.role === 'tool') {
      const tool = pending.shift()
      if (!fresh || !tool) continue
      if (TOOL_ERROR.test(r.head.trimStart())) errors.set(tool, (errors.get(tool) ?? 0) + 1)
      continue
    }
    for (const m of r.head.matchAll(TOOL_HEADER)) {
      pending.push(m[1])
      if (fresh) calls.set(m[1], (calls.get(m[1]) ?? 0) + 1)
    }
  }
  return [...calls.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 20)
    .map(([tool, n]) => ({ tool, calls: n, errors: errors.get(tool) ?? 0 }))
}

export function computeStats(db: DbHandle, now: Date = new Date()): StatsPayload {
  const totalProjects = (db.prepare(`SELECT COUNT(*) AS c FROM projects`).get() as { c: number }).c
  const totalSessions = (db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c
  const archivedSessions = (
    db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE archived_at IS NOT NULL`).get() as { c: number }
  ).c
  const archivedPlans = (
    db.prepare(`SELECT COUNT(*) AS c FROM plan_files WHERE archived_at IS NOT NULL`).get() as { c: number }
  ).c
  const totalMessages = (db.prepare(`SELECT COUNT(DISTINCT msg_key) AS c FROM messages`).get() as { c: number }).c
  const totalPrompts = (
    db.prepare(`SELECT COUNT(DISTINCT msg_key) AS c FROM ${PROMPTS} WHERE is_prompt = 1`).get() as { c: number }
  ).c

  const messagesByRole = db.prepare(ROLES_SQL).all() as { role: string; count: number }[]

  // What *I* keep asking about: count the prompts a word appears in, not its raw
  // occurrences — one pasted log would otherwise outweigh weeks of real questions.
  const freq = new Map<string, number>()
  for (const { body } of db
    .prepare(`SELECT prompt_text AS body FROM ${PROMPTS} WHERE is_prompt = 1 GROUP BY msg_key`)
    .iterate() as Iterable<{
    body: string
  }>) {
    for (const t of new Set(tokenize(body))) freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  const topTokens = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([token, count]) => ({ token, count }))

  const tokensByModel = db
    .prepare(
      `SELECT model,
              COUNT(*) AS messages,
              SUM(input) AS input,
              SUM(output) AS output,
              SUM(cacheRead) AS cacheRead,
              SUM(cacheCreation) AS cacheCreation,
              SUM(cacheCreation1h) AS cacheCreation1h
       FROM (${RESPONSES_SQL})
       WHERE model IS NOT NULL AND model != ''
       GROUP BY model
       ORDER BY (input + output) DESC, messages DESC
       LIMIT 40`,
    )
    .all() as ModelTokenRow[]

  const tokenTotals = tokensByModel.reduce(
    (acc, m) => ({
      input: acc.input + m.input,
      output: acc.output + m.output,
      cacheRead: acc.cacheRead + m.cacheRead,
      cacheCreation: acc.cacheCreation + m.cacheCreation,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  )

  // Prompts per day is the clearest signal of when I actually worked; tool chatter
  // and bookkeeping would inflate busy days by orders of magnitude.
  const activityFromTimestamps = totalPrompts > 0
  const activityByDay = activityFromTimestamps
    ? (db
        .prepare(
          `SELECT strftime('%Y-%m-%d', datetime(ts_ms / 1000, 'unixepoch', 'localtime')) AS day, COUNT(DISTINCT msg_key) AS count
           FROM ${PROMPTS}
           WHERE is_prompt = 1 AND ts_ms IS NOT NULL
           GROUP BY day
           ORDER BY day DESC
           LIMIT 120`,
        )
        .all() as { day: string; count: number }[])
    : (db
        .prepare(
          `SELECT strftime('%Y-%m-%d', datetime(s.file_mtime_ms / 1000, 'unixepoch', 'localtime')) AS day, COUNT(*) AS count
           FROM sessions s
           GROUP BY day
           ORDER BY day DESC
           LIMIT 120`,
        )
        .all() as { day: string; count: number }[])

  const appOpenDays = (
    db
      .prepare(`SELECT day FROM app_opens WHERE day >= date('now', 'localtime', '-62 days') ORDER BY day`)
      .all() as { day: string }[]
  ).map((r) => r.day)

  return {
    totalProjects,
    totalSessions,
    archivedSessions,
    archivedPlans,
    totalMessages,
    totalPrompts,
    messagesByRole,
    topTokens,
    activityByDay: activityByDay.reverse(),
    tokenTotals,
    tokensByModel,
    activityFromTimestamps,
    appOpenDays,
    ...promptActivity(db, now),
    ...responseUsage(db),
    toolUsage: toolUsage(db),
  }
}

export const EMPTY_STATS: StatsPayload = {
  totalProjects: 0,
  totalSessions: 0,
  archivedSessions: 0,
  archivedPlans: 0,
  totalMessages: 0,
  totalPrompts: 0,
  messagesByRole: [],
  topTokens: [],
  activityByDay: [],
  tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  tokensByModel: [],
  activityFromTimestamps: false,
  appOpenDays: [],
  activityYear: [],
  activityByHour: [],
  tokensByProject: [],
  toolUsage: [],
  usageBlocks: [],
}

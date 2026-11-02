import type { DbHandle } from './db.js'
import type { ModelTokenRow } from '../shared/ipc.js'
import type { StatsPayload } from '../shared/ipc.js'

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

export function computeStats(db: DbHandle): StatsPayload {
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
}

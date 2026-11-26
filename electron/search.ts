import type { DbHandle } from './db.js'
import type {
  MessageClass,
  MessageHit,
  PlanHit,
  SearchFilters,
  SearchHit,
  SortMode,
  UnifiedSearchHit,
} from '../shared/ipc.js'

export type MatchMode = 'any' | 'all' | 'phrase'

/** Bodies can be megabytes of tool output; hits carry a clamped copy (full text via `messageBody`). */
export const HIT_BODY_CLAMP = 2000

/**
 * Build an FTS5 query from a raw string.
 * - `phrase`: the whole query is matched as one exact phrase.
 * - `any` / `all`: `"quoted groups"` become exact phrases, bare words become
 *   prefix matches (`word*`), joined by OR (`any`) or AND (`all`).
 * Everything is wrapped in double quotes so FTS special characters stay literal;
 * internal double quotes are stripped to keep the phrase well-formed.
 */
export function buildFtsQuery(raw: string, mode: MatchMode = 'any'): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  if (mode === 'phrase') {
    const cleaned = trimmed.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
    return cleaned ? `"${cleaned}"` : ''
  }

  const terms: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed)) !== null) {
    if (m[1] != null) {
      const phrase = m[1].replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
      if (phrase) terms.push(`"${phrase}"`)
    } else if (m[2] != null) {
      const tok = m[2].replace(/"/g, '').trim()
      if (tok) terms.push(`"${tok}"*`)
    }
  }
  if (terms.length === 0) return ''
  return terms.join(mode === 'all' ? ' AND ' : ' OR ')
}

/** `LIKE` pattern for a literal substring (escape char `\`). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

type Where = { sql: string; params: (string | number)[] }

/** Filters shared by every message query path. `m`, `s`, `p` are the usual aliases. */
function rowFilters(filters: SearchFilters, opts: { metaOnly?: boolean } = {}): Where {
  const parts: string[] = []
  const params: (string | number)[] = []
  if (opts.metaOnly) parts.push(`m.message_class = 'meta'`)
  else if (filters.excludeMeta !== false) parts.push(`m.message_class != 'meta'`)
  if (filters.excludeSubagents) parts.push(`s.rel_path NOT LIKE '%subagents%'`)
  if (filters.excludeTools) {
    parts.push(`m.role != 'tool' AND COALESCE(m.content_kinds, '') NOT LIKE '%"tool_use"%'`)
  }
  if (filters.projectId != null) {
    parts.push(`p.id = ?`)
    params.push(filters.projectId)
  }
  if (filters.role === 'user' || filters.role === 'assistant') {
    parts.push(`m.role = ?`)
    params.push(filters.role)
  }
  if (filters.tagId != null) {
    parts.push(`EXISTS (SELECT 1 FROM message_tags mt WHERE mt.msg_key = m.msg_key AND mt.tag_id = ?)`)
    params.push(filters.tagId)
  }
  if (typeof filters.sinceMs === 'number' && Number.isFinite(filters.sinceMs)) {
    parts.push(`m.ts_ms IS NOT NULL AND m.ts_ms >= ?`)
    params.push(Math.trunc(filters.sinceMs))
  }
  if (typeof filters.untilMs === 'number' && Number.isFinite(filters.untilMs)) {
    parts.push(`m.ts_ms IS NOT NULL AND m.ts_ms <= ?`)
    params.push(Math.trunc(filters.untilMs))
  }
  if (filters.projectQuery) {
    parts.push(`p.display_name LIKE ? ESCAPE '\\'`)
    params.push(likePattern(filters.projectQuery))
  }
  if (filters.branch) {
    parts.push(`m.git_branch LIKE ? ESCAPE '\\'`)
    params.push(likePattern(filters.branch))
  }
  if (filters.archived === 'archived') parts.push(`s.archived_at IS NOT NULL`)
  else if (filters.archived === 'live') parts.push(`s.archived_at IS NULL`)
  if (filters.sessionId != null) {
    parts.push(`s.id = ?`)
    params.push(filters.sessionId)
  }
  return { sql: parts.length ? parts.map((p) => `(${p})`).join(' AND ') : '1=1', params }
}

/** ORDER BY clause for a message search; NULL timestamps sort last for time sorts. */
function messageOrderBy(sort: SortMode | undefined, relevance: string): string {
  if (sort === 'newest') return 'ORDER BY (m.ts_ms IS NULL) ASC, m.ts_ms DESC, m.id DESC'
  if (sort === 'oldest') return 'ORDER BY (m.ts_ms IS NULL) ASC, m.ts_ms ASC, m.id ASC'
  return relevance
}

const HIT_COLUMNS = `
  m.id AS message_id,
  m.msg_key AS msg_key,
  s.id AS session_id,
  p.id AS project_id,
  p.slug AS project_slug,
  p.display_name AS project_name,
  s.rel_path AS session_file,
  m.line_index,
  m.role,
  substr(m.body, 1, ${HIT_BODY_CLAMP}) AS body,
  length(m.body) > ${HIT_BODY_CLAMP} AS body_truncated,
  m.message_class AS message_class,
  m.ts_ms AS ts_ms,
  (SELECT group_concat(mt.tag_id) FROM message_tags mt WHERE mt.msg_key = m.msg_key) AS tag_ids,
  EXISTS (SELECT 1 FROM favorites f WHERE f.msg_key = m.msg_key) AS is_favorite,
  s.archived_at IS NOT NULL AS archived`

type HitRow = {
  message_id: number
  msg_key: string
  session_id: number
  project_id: number
  project_slug: string
  project_name: string
  session_file: string
  line_index: number
  role: string
  body: string
  body_truncated: number
  snippet: string
  rank: number
  message_class: string
  ts_ms: number | null
  tag_ids: string | null
  is_favorite: number
  archived: number
}

export function parseIdList(csv: string | null): number[] {
  if (!csv) return []
  return csv
    .split(',')
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0)
}

function mapRows(rows: HitRow[]): SearchHit[] {
  return rows.map((r) => ({
    messageId: r.message_id,
    msgKey: r.msg_key,
    sessionId: r.session_id,
    projectId: r.project_id,
    projectSlug: r.project_slug,
    projectName: r.project_name,
    sessionFile: r.session_file,
    lineIndex: r.line_index,
    role: r.role,
    body: r.body,
    bodyTruncated: Boolean(r.body_truncated),
    snippet: r.snippet,
    rank: r.rank,
    messageClass: (r.message_class as MessageClass) || 'dialog',
    tsMs: r.ts_ms ?? null,
    tagIds: parseIdList(r.tag_ids),
    isFavorite: Boolean(r.is_favorite),
    archived: Boolean(r.archived),
  }))
}

function likeSearch(db: DbHandle, filters: SearchFilters, limit: number, metaOnly: boolean, offset = 0): SearchHit[] {
  const q = filters.query.trim()
  const where = rowFilters(filters, { metaOnly })
  const textWhere = q ? `m.body LIKE ? ESCAPE '\\'` : '1=1'
  const sql = `
    SELECT ${HIT_COLUMNS}, substr(m.body, 1, 120) AS snippet, 0 AS rank
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    JOIN projects p ON p.id = s.project_id
    WHERE ${textWhere} AND ${where.sql}
    ${messageOrderBy(filters.sort, 'ORDER BY (m.ts_ms IS NULL) ASC, m.ts_ms DESC, m.id DESC')}
    LIMIT ${limit} OFFSET ${offset}`
  const params = q ? [likePattern(q), ...where.params] : where.params
  return mapRows(db.prepare(sql).all(...params) as HitRow[])
}

/** Handles that already have the `regexp` SQL function. */
const withRegexp = new WeakSet<DbHandle>()
/** One compiled pattern per query, not per row. */
let lastRegex: { key: string; re: RegExp | null } = { key: '', re: null }

function compiled(source: string, flags: string): RegExp | null {
  const key = `${flags}/${source}`
  if (lastRegex.key !== key) {
    let re: RegExp | null = null
    try {
      re = new RegExp(source, flags.replace(/[gy]/g, ''))
    } catch {
      re = null
    }
    lastRegex = { key, re }
  }
  return lastRegex.re
}

/** SQLite has no REGEXP of its own; `x REGEXP y` calls `regexp(y, x)`. Flags travel as `flags/source`. */
function ensureRegexp(db: DbHandle): void {
  if (withRegexp.has(db)) return
  db.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (typeof pattern !== 'string' || typeof value !== 'string') return 0
    const slash = pattern.indexOf('/')
    const re = compiled(pattern.slice(slash + 1), pattern.slice(0, slash))
    return re && re.test(value) ? 1 : 0
  })
  withRegexp.add(db)
}

/** A «marked» excerpt around the first match, like FTS `snippet()`. */
export function regexSnippet(body: string, re: RegExp, radius = 60): string {
  const m = re.exec(body)
  if (!m) return body.slice(0, 120)
  const start = Math.max(0, m.index - radius)
  const end = Math.min(body.length, m.index + m[0].length + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, m.index)}«${m[0]}»${body.slice(m.index + m[0].length, end)}${end < body.length ? '…' : ''}`
}

/** A scan of every body through a JS regex: slow, so only on the query worker and only on request. */
function regexSearch(db: DbHandle, filters: SearchFilters, limit: number, offset: number): SearchHit[] {
  const source = filters.regex ?? ''
  const flags = (filters.regexFlags ?? '').replace(/[^imsu]/g, '')
  const re = compiled(source, flags)
  if (!re) return []
  ensureRegexp(db)
  const where = rowFilters(filters)
  const sql = `
    SELECT ${HIT_COLUMNS}, '' AS snippet, 0 AS rank
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    JOIN projects p ON p.id = s.project_id
    WHERE m.body REGEXP ? AND ${where.sql}
    ${messageOrderBy(filters.sort, 'ORDER BY (m.ts_ms IS NULL) ASC, m.ts_ms DESC, m.id DESC')}
    LIMIT ${limit} OFFSET ${offset}`
  const hits = mapRows(db.prepare(sql).all(`${flags}/${source}`, ...where.params) as HitRow[])
  return hits.map((h) => ({ ...h, snippet: regexSnippet(h.body, new RegExp(re.source, re.flags)) }))
}

export function searchMessages(db: DbHandle, filters: SearchFilters): SearchHit[] {
  const limit = Math.min(filters.limit ?? 80, 200)
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0))
  if (filters.regex) return regexSearch(db, filters, limit, offset)
  const q = filters.query.trim()
  if (!q) {
    // An empty query is only meaningful as "everything with this tag" (or in one session).
    return filters.tagId != null || filters.sessionId != null ? likeSearch(db, filters, limit, false, offset) : []
  }
  const fts = buildFtsQuery(q, filters.matchMode)
  let hits: SearchHit[] = []
  let ftsOk = false
  if (fts) {
    const where = rowFilters(filters)
    const sql = `
      SELECT ${HIT_COLUMNS},
        snippet(messages_fts, 0, '«', '»', '…', 32) AS snippet,
        bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.id = m.session_id
      JOIN projects p ON p.id = s.project_id
      WHERE messages_fts MATCH ? AND ${where.sql}
      ${messageOrderBy(filters.sort, 'ORDER BY rank')}
      LIMIT ${limit} OFFSET ${offset}`
    try {
      hits = mapRows(db.prepare(sql).all(fts, ...where.params) as HitRow[])
      ftsOk = true
    } catch {
      /* malformed FTS query → substring fallback below */
    }
    // A later page that comes back empty only means the token results ran out — unless
    // there were never any, in which case the first page was the substring fallback.
    if (ftsOk && hits.length === 0 && offset > 0) {
      const any = db
        .prepare(
          `SELECT 1 FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
           JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
           WHERE messages_fts MATCH ? AND ${where.sql} LIMIT 1`,
        )
        .get(fts, ...where.params)
      if (any) return []
    }
  }
  // Token search can't match inside a word ("색인" in "재색인"); when it finds
  // nothing, fall back to a substring scan so infix queries still work.
  // A one-character scan of every body finds nothing FTS prefixes would miss.
  if ((!ftsOk || hits.length === 0) && q.length >= 2) {
    hits = likeSearch(db, filters, limit, false, offset)
  }
  // Bookkeeping lines are not in the FTS index; include them only when asked to (first page).
  if (filters.excludeMeta === false && hits.length < limit && offset === 0) {
    const seen = new Set(hits.map((h) => h.messageId))
    for (const h of likeSearch(db, filters, limit - hits.length, true)) {
      if (!seen.has(h.messageId)) hits.push(h)
    }
  }
  return hits
}

function mapPlanRows(
  rows: {
    plan_id: number
    file_path: string
    title: string
    snippet: string
    rank: number
    mtime: number
    archived: number
  }[],
): PlanHit[] {
  return rows.map((r) => ({
    hitType: 'plan' as const,
    planId: r.plan_id,
    filePath: r.file_path,
    title: r.title,
    snippet: r.snippet,
    rank: r.rank,
    mtime: r.mtime,
    archived: r.archived === 1,
  }))
}

export function searchPlans(db: DbHandle, filters: SearchFilters): PlanHit[] {
  if (!filters.query.trim()) {
    return []
  }
  const limit = Math.min(filters.limit ?? 80, 200)
  const offset = Math.max(0, Math.trunc(filters.planOffset ?? 0))
  const fts = buildFtsQuery(filters.query, filters.matchMode)
  const planDate: string[] = []
  const planDateParams: number[] = []
  if (typeof filters.sinceMs === 'number' && Number.isFinite(filters.sinceMs)) {
    planDate.push(`pf.file_mtime_ms >= ?`)
    planDateParams.push(Math.trunc(filters.sinceMs))
  }
  if (typeof filters.untilMs === 'number' && Number.isFinite(filters.untilMs)) {
    planDate.push(`pf.file_mtime_ms <= ?`)
    planDateParams.push(Math.trunc(filters.untilMs))
  }
  const planDateSql = planDate.length ? ` AND ${planDate.join(' AND ')}` : ''
  const planOrder =
    filters.sort === 'newest' || filters.sort === 'oldest'
      ? `ORDER BY pf.file_mtime_ms ${filters.sort === 'newest' ? 'DESC' : 'ASC'}`
      : 'ORDER BY rank'

  if (fts) {
    const ftsSql = `
      SELECT
        pf.id AS plan_id,
        pf.file_path,
        pf.title,
        pf.file_mtime_ms AS mtime,
        pf.archived_at IS NOT NULL AS archived,
        snippet(plan_files_fts, 1, '«', '»', '…', 48) AS snippet,
        bm25(plan_files_fts) AS rank
      FROM plan_files_fts
      JOIN plan_files pf ON pf.id = plan_files_fts.rowid
      WHERE plan_files_fts MATCH ?${planDateSql}
      ${planOrder}
      LIMIT ${limit} OFFSET ${offset}
    `
    try {
      const rows = db.prepare(ftsSql).all(fts, ...planDateParams) as Parameters<typeof mapPlanRows>[0]
      if (rows.length || offset > 0) return mapPlanRows(rows)
    } catch {
      /* LIKE fallback */
    }
  }

  const likeSql = `
    SELECT
      pf.id AS plan_id,
      pf.file_path,
      pf.title,
      pf.file_mtime_ms AS mtime,
      pf.archived_at IS NOT NULL AS archived,
      substr(pf.body, 1, 160) AS snippet,
      0 AS rank
    FROM plan_files pf
    WHERE (pf.title LIKE ? ESCAPE '\\' OR pf.body LIKE ? ESCAPE '\\')${planDateSql}
    ORDER BY pf.file_mtime_ms DESC
    LIMIT ${limit} OFFSET ${offset}
  `
  const pat = likePattern(filters.query.trim())
  const rows = db.prepare(likeSql).all(pat, pat, ...planDateParams) as Parameters<typeof mapPlanRows>[0]
  return mapPlanRows(rows)
}

/**
 * `relevance` (default): BM25 scales aren't comparable across the message/plan
 * FTS tables, so results stay sectioned — all messages (by rank) then all plans
 * (by rank). For time sorts both scopes share an epoch-ms clock (message `tsMs`,
 * plan `mtime`), so hits are interleaved by time; missing times sort last.
 */
export function orderedAllScopeHits(
  messageHits: MessageHit[],
  planHits: PlanHit[],
  sort: SortMode = 'relevance',
): UnifiedSearchHit[] {
  if (sort === 'newest' || sort === 'oldest') {
    const timeOf = (h: UnifiedSearchHit): number | null =>
      h.hitType === 'plan' ? h.mtime : h.tsMs
    const dir = sort === 'newest' ? -1 : 1
    return [...messageHits, ...planHits].sort((a, b) => {
      const ta = timeOf(a)
      const tb = timeOf(b)
      if (ta == null && tb == null) return 0
      if (ta == null) return 1
      if (tb == null) return -1
      return (ta - tb) * dir
    })
  }
  const byMsgRank = (a: MessageHit, b: MessageHit) =>
    a.rank !== b.rank ? a.rank - b.rank : b.messageId - a.messageId
  const byPlanRank = (a: PlanHit, b: PlanHit) =>
    a.rank !== b.rank ? a.rank - b.rank : b.mtime - a.mtime
  return [...[...messageHits].sort(byMsgRank), ...[...planHits].sort(byPlanRank)]
}

export function unifiedSearch(db: DbHandle, filters: SearchFilters): UnifiedSearchHit[] {
  const scope = filters.scope ?? 'messages'
  /** `plan_files`에 project_id·태그 없음 — 프로젝트나 태그로 좁히면 대화만 검색 */
  const narrowed =
    filters.projectId != null ||
    filters.tagId != null ||
    filters.projectQuery != null ||
    filters.branch != null ||
    filters.sessionId != null ||
    filters.regex != null
  const messages =
    scope === 'messages' || scope === 'all'
      ? searchMessages(db, filters).map((h): UnifiedSearchHit => ({ ...h, hitType: 'message' }))
      : []
  const wantPlans = scope === 'plans' || (scope === 'all' && !narrowed)
  const plans = wantPlans ? searchPlans(db, filters) : []

  if (scope === 'all') {
    return orderedAllScopeHits(messages as MessageHit[], plans as PlanHit[], filters.sort)
  }
  if (scope === 'plans') return plans
  return messages
}

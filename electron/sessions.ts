import type { DbHandle } from './db.js'
import { likePattern } from './search.js'
import { sessionTranscript } from './queries.js'
import { forkCommand, isSubagentPath, resumeCommand } from '../shared/resume.js'
import { redactSecrets } from '../shared/redact.js'
import type {
  MaskedText,
  ModelTokenRow,
  SessionDetail,
  SessionExportFormat,
  SessionExportOptions,
  SessionListQuery,
  SessionListResult,
  SessionListRow,
  SessionMessageRow,
  SubagentRow,
  TranscriptPage,
} from '../shared/ipc.js'

/** Subagent transcripts live in `{uuid}/subagents/`; `_` matches either path separator. */
const NOT_SUBAGENT = `s.rel_path NOT LIKE '%subagents_%'`
/** Children of session `s`: `{uuid}.jsonl` → `{uuid}/subagents/…`. */
const CHILD_OF_S = `c.project_id = s.project_id AND c.rel_path LIKE replace(s.rel_path, '.jsonl', '') || '_subagents_%'`

/** First thing I typed in a session, else its first conversation line. */
const PREVIEW = (alias: string) => `(
  SELECT substr(COALESCE(m2.prompt_text, m2.body), 1, 200) FROM messages m2
  WHERE m2.session_id = ${alias}.id AND m2.message_class != 'meta'
  ORDER BY m2.is_prompt DESC, m2.line_index ASC LIMIT 1)`

type ListRow = Omit<SessionListRow, 'archived'> & { archived: number }

export function listSessions(db: DbHandle, q: SessionListQuery): SessionListResult {
  const where: string[] = [NOT_SUBAGENT]
  const params: (string | number)[] = []
  if (q.projectId != null) {
    where.push('s.project_id = ?')
    params.push(q.projectId)
  }
  if (q.archived === 'archived') where.push('s.archived_at IS NOT NULL')
  else if (q.archived === 'live') where.push('s.archived_at IS NULL')
  const text = (q.query ?? '').trim()
  if (text) {
    const pat = likePattern(text)
    where.push(`(s.title LIKE ? ESCAPE '\\' OR s.cwd LIKE ? ESCAPE '\\' OR s.git_branch LIKE ? ESCAPE '\\'
      OR p.display_name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM messages mp WHERE mp.session_id = s.id AND mp.is_prompt = 1
                 AND mp.prompt_text LIKE ? ESCAPE '\\'))`)
    params.push(pat, pat, pat, pat, pat)
  }
  const order =
    q.sort === 'oldest'
      ? 'COALESCE(s.first_ts_ms, s.file_mtime_ms) ASC, s.id ASC'
      : q.sort === 'longest'
        ? 's.message_count DESC, s.id DESC'
        : 'COALESCE(s.last_ts_ms, s.file_mtime_ms) DESC, s.id DESC'
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), 200)
  const offset = Math.max(0, Math.trunc(q.offset ?? 0))
  const whereSql = where.join(' AND ')
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM sessions s JOIN projects p ON p.id = s.project_id WHERE ${whereSql}`)
      .get(...params) as { c: number }
  ).c
  const rows = db
    .prepare(
      `SELECT s.id AS sessionId, p.id AS projectId, p.display_name AS projectName, p.tool,
              s.rel_path AS sessionFile, s.title, ${PREVIEW('s')} AS preview, s.cwd, s.git_branch AS gitBranch,
              s.first_ts_ms AS firstTsMs, s.last_ts_ms AS lastTsMs, s.file_mtime_ms AS mtime,
              s.message_count AS messageCount,
              (SELECT COUNT(*) FROM sessions c WHERE ${CHILD_OF_S}) AS subagentCount,
              s.archived_at IS NOT NULL AS archived, s.archived_at AS archivedAt
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE ${whereSql}
       ORDER BY ${order}
       LIMIT ${limit} OFFSET ${offset}`,
    )
    .all(...params) as ListRow[]
  return { rows: rows.map((r) => ({ ...r, tool: r.tool ?? 'claude', archived: Boolean(r.archived) })), total }
}

/** Per-model usage of one session, each API response counted once (see stats.ts). */
function sessionTokens(db: DbHandle, sessionIds: number[]): ModelTokenRow[] {
  if (!sessionIds.length) return []
  const ph = sessionIds.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT model, COUNT(*) AS messages, SUM(input) AS input, SUM(output) AS output, SUM(cacheRead) AS cacheRead,
              SUM(cacheCreation) AS cacheCreation, SUM(cacheCreation1h) AS cacheCreation1h
       FROM (
         SELECT MAX(model) AS model, MAX(COALESCE(input_tokens, 0)) AS input, MAX(COALESCE(output_tokens, 0)) AS output,
                MAX(COALESCE(cache_read_tokens, 0)) AS cacheRead, MAX(COALESCE(cache_creation_tokens, 0)) AS cacheCreation,
                MAX(COALESCE(cache_creation_1h_tokens, 0)) AS cacheCreation1h
         FROM messages
         WHERE session_id IN (${ph}) AND input_tokens IS NOT NULL
         GROUP BY CASE WHEN api_msg_id IS NOT NULL THEN api_msg_id || ':' || COALESCE(request_id, '')
                       ELSE 'key:' || msg_key END
       )
       GROUP BY model
       ORDER BY output + input DESC`,
    )
    .all(...sessionIds)
    .map((r) => {
      const row = r as ModelTokenRow & { model: string | null }
      return { ...row, model: row.model ?? 'unknown' }
    })
}

export function sessionDetail(db: DbHandle, sessionId: number, platform: string = process.platform): SessionDetail | null {
  const s = db
    .prepare(
      `SELECT s.id AS sessionId, p.id AS projectId, p.display_name AS projectName, p.tool, s.rel_path AS sessionFile,
              s.file_path AS filePath, s.title, s.cwd, s.git_branch AS gitBranch, s.first_ts_ms AS firstTsMs,
              s.last_ts_ms AS lastTsMs, s.message_count AS messageCount, s.archived_at AS archivedAt
       FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
    )
    .get(sessionId) as
    | Omit<SessionDetail, 'promptCount' | 'resumeCommand' | 'forkCommand' | 'parentSessionId' | 'subagents' | 'tokensByModel' | 'filesTouched'>
    | undefined
  if (!s) return null
  const tool = s.tool ?? 'claude'
  const promptCount = (
    db
      .prepare(`SELECT COUNT(DISTINCT msg_key) AS c FROM messages WHERE session_id = ? AND is_prompt = 1`)
      .get(sessionId) as { c: number }
  ).c
  const filesTouched = (
    db
      .prepare(`SELECT COUNT(DISTINCT f.path) AS c FROM file_refs f JOIN messages m ON m.id = f.message_id WHERE m.session_id = ?`)
      .get(sessionId) as { c: number }
  ).c
  let parentSessionId: number | null = null
  if (isSubagentPath(s.sessionFile)) {
    const parentRel = s.sessionFile.split(/[\\/]subagents[\\/]/)[0]
    const parent = db
      .prepare(`SELECT id FROM sessions WHERE project_id = ? AND (rel_path = ? OR rel_path LIKE ?) ORDER BY archived_at IS NOT NULL, id DESC LIMIT 1`)
      .get(s.projectId, `${parentRel}.jsonl`, `${parentRel}.jsonl#archived-%`) as { id: number } | undefined
    parentSessionId = parent?.id ?? null
  }
  const subagents = db
    .prepare(
      `SELECT c.id AS sessionId, c.rel_path AS sessionFile, c.title, ${PREVIEW('c')} AS preview,
              c.message_count AS messageCount, c.first_ts_ms AS firstTsMs, c.last_ts_ms AS lastTsMs
       FROM sessions s JOIN sessions c ON ${CHILD_OF_S}
       WHERE s.id = ?
       ORDER BY COALESCE(c.first_ts_ms, c.file_mtime_ms), c.id`,
    )
    .all(sessionId) as SubagentRow[]
  // The resume target is the parent session, whose cwd a subagent shares.
  const target = { tool, relPath: s.sessionFile, cwd: s.cwd }
  return {
    ...s,
    tool,
    promptCount,
    filesTouched,
    parentSessionId,
    subagents,
    resumeCommand: resumeCommand(target, platform),
    forkCommand: forkCommand(target, platform),
    tokensByModel: sessionTokens(db, [sessionId, ...subagents.map((a) => a.sessionId)]),
  }
}

export const TRANSCRIPT_PAGE_ROWS = 2000

/**
 * One window of a transcript. With `aroundLine`, the window starts a little before that
 * line so a search hit deep in a 50k-line session is loaded without the lines before it.
 */
export function transcriptPage(
  db: DbHandle,
  sessionId: number,
  opts: { from?: number; aroundLine?: number; limit?: number } = {},
): TranscriptPage {
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ?`).get(sessionId) as { c: number }).c
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? TRANSCRIPT_PAGE_ROWS), 1), 5000)
  let from = Math.max(0, Math.trunc(opts.from ?? 0))
  if (opts.aroundLine != null && opts.aroundLine >= 0) {
    const pos = (
      db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND line_index < ?`).get(sessionId, opts.aroundLine) as {
        c: number
      }
    ).c
    from = Math.max(0, pos - Math.floor(limit / 10))
  }
  from = Math.min(from, Math.max(0, total - 1))
  const rows = sessionTranscript(db, sessionId, { offset: from, limit })
  return { rows, from, total }
}

const ROLE_LABEL: Record<'ko' | 'en', Record<string, string>> = {
  ko: { user: '나', assistant: 'Claude', tool: '도구', system: '시스템', unknown: '기타' },
  en: { user: 'Me', assistant: 'Claude', tool: 'Tool', system: 'System', unknown: 'Other' },
}

function isToolRow(m: SessionMessageRow): boolean {
  return m.role === 'tool' || m.contentKinds.includes('tool_use')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function fmtTime(ms: number | null): string {
  return ms == null ? '' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

/** The whole session as Markdown or a self-contained HTML page. */
export function exportSession(
  db: DbHandle,
  sessionId: number,
  format: SessionExportFormat,
  opts: SessionExportOptions & { mask: boolean; locale: 'ko' | 'en' },
): MaskedText {
  const d = sessionDetail(db, sessionId)
  if (!d) return { text: '', masked: 0 }
  const labels = ROLE_LABEL[opts.locale]
  const rows = sessionTranscript(db, sessionId, { limit: 1_000_000 }).filter(
    (m) => (opts.includeMeta || m.messageClass !== 'meta') && (opts.includeTools || !isToolRow(m)),
  )
  const tsOf = new Map(
    (db.prepare(`SELECT line_index AS li, ts_ms AS ts FROM messages WHERE session_id = ?`).all(sessionId) as { li: number; ts: number | null }[]).map(
      (r) => [r.li, r.ts],
    ),
  )
  const title = d.title || d.sessionFile
  const meta: [string, string][] = [
    [opts.locale === 'ko' ? '프로젝트' : 'Project', d.projectName],
    [opts.locale === 'ko' ? '작업 폴더' : 'Directory', d.cwd ?? ''],
    [opts.locale === 'ko' ? '브랜치' : 'Branch', d.gitBranch ?? ''],
    [opts.locale === 'ko' ? '기간' : 'Period', `${fmtTime(d.firstTsMs)} – ${fmtTime(d.lastTsMs)}`],
    [opts.locale === 'ko' ? '파일' : 'File', d.sessionFile],
  ]
  let text: string
  if (format === 'md') {
    const head = [`# ${title}`, '', ...meta.filter(([, v]) => v.trim()).map(([k, v]) => `- **${k}:** ${v}`), '']
    const body = rows.map((m) => {
      const who = labels[m.role] ?? m.role
      const ts = fmtTime(tsOf.get(m.lineIndex) ?? null)
      const fence = isToolRow(m) || m.messageClass === 'meta'
      const content = fence ? `\`\`\`\n${m.body.replace(/```/g, '`​``')}\n\`\`\`` : m.body
      return `### ${who}${ts ? ` · ${ts}` : ''}\n\n${content}\n`
    })
    text = [...head, ...body].join('\n')
  } else {
    const items = rows
      .map((m) => {
        const who = labels[m.role] ?? m.role
        const ts = fmtTime(tsOf.get(m.lineIndex) ?? null)
        const cls = isToolRow(m) ? 'tool' : m.role === 'user' ? 'me' : m.messageClass === 'meta' ? 'meta' : 'ai'
        return `<article class="${cls}"><header><b>${escapeHtml(who)}</b> <time>${escapeHtml(ts)}</time></header><pre>${escapeHtml(m.body)}</pre></article>`
      })
      .join('\n')
    const metaHtml = meta
      .filter(([, v]) => v.trim())
      .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
      .join('')
    text = `<!doctype html>
<html lang="${opts.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfd;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--line:#e5e5ea;--me:#eef4ff;--tool:#f5f5f7}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1c1c1f;--ink:#f2f2f4;--ink2:#a1a1a6;--line:#2c2c30;--me:#1b2738;--tool:#232326}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Pretendard","Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}
h1{font-size:24px;margin:0 0 12px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0 0 24px;color:var(--ink2);font-size:13px}
dl div{display:contents}dt{font-weight:600}dd{margin:0;word-break:break-all}
article{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:0 0 12px}
article.me{background:var(--me)}article.tool,article.meta{background:var(--tool);font-size:13px}
header{font-size:12.5px;color:var(--ink2);margin-bottom:6px}time{margin-left:6px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit}
article.tool pre,article.meta pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><dl>${metaHtml}</dl>
${items}
</main></body></html>
`
  }
  if (!opts.mask) return { text, masked: 0 }
  const r = redactSecrets(text)
  return { text: r.text, masked: r.count }
}

const HANDOFF_PROMPTS = 40
const HANDOFF_PROMPT_CHARS = 600
const HANDOFF_REPLY_CHARS = 3000

/**
 * Context for continuing a session that can no longer be resumed (its file is gone):
 * what it was, where, which files, what I asked, and where Claude left off.
 */
export function handoffPrompt(db: DbHandle, sessionId: number, opts: { mask: boolean; locale: 'ko' | 'en' }): MaskedText {
  const d = sessionDetail(db, sessionId)
  if (!d) return { text: '', masked: 0 }
  const ko = opts.locale === 'ko'
  const prompts = db
    .prepare(
      `SELECT prompt_text AS t FROM messages WHERE session_id = ? AND is_prompt = 1 GROUP BY msg_key ORDER BY MIN(line_index)`,
    )
    .all(sessionId) as { t: string }[]
  const files = db
    .prepare(
      `SELECT f.path, COUNT(*) AS n FROM file_refs f JOIN messages m ON m.id = f.message_id
       WHERE m.session_id = ? GROUP BY f.path ORDER BY n DESC, f.path LIMIT 20`,
    )
    .all(sessionId) as { path: string; n: number }[]
  const lastReply = db
    .prepare(
      `SELECT body FROM messages WHERE session_id = ? AND role = 'assistant' AND message_class = 'dialog'
       AND COALESCE(content_kinds, '') LIKE '%"text"%' ORDER BY line_index DESC LIMIT 1`,
    )
    .get(sessionId) as { body: string } | undefined
  const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
  const shown = prompts.length > HANDOFF_PROMPTS ? [...prompts.slice(0, 5), ...prompts.slice(-(HANDOFF_PROMPTS - 5))] : prompts
  const lines: string[] = [
    ko
      ? '아래는 이전 Claude Code 세션의 맥락이에요. 이 맥락을 이어서 작업해 주세요.'
      : 'Below is the context of an earlier Claude Code session. Please continue from it.',
    '',
    `## ${ko ? '세션' : 'Session'}`,
    `- ${ko ? '제목' : 'Title'}: ${d.title ?? '-'}`,
    `- ${ko ? '작업 폴더' : 'Directory'}: ${d.cwd ?? d.projectName}`,
    ...(d.gitBranch ? [`- ${ko ? '브랜치' : 'Branch'}: ${d.gitBranch}`] : []),
    `- ${ko ? '기간' : 'Period'}: ${fmtTime(d.firstTsMs)} – ${fmtTime(d.lastTsMs)}`,
  ]
  if (files.length) {
    lines.push('', `## ${ko ? '다룬 파일' : 'Files touched'}`, ...files.map((f) => `- ${f.path}`))
  }
  if (shown.length) {
    lines.push('', `## ${ko ? '내가 한 요청 (순서대로)' : 'What I asked (in order)'}`)
    shown.forEach((p, i) => {
      if (prompts.length > HANDOFF_PROMPTS && i === 5) lines.push(`- … (${prompts.length - HANDOFF_PROMPTS})`)
      lines.push(`${i + 1}. ${clamp(p.t.replace(/\s+/g, ' ').trim(), HANDOFF_PROMPT_CHARS)}`)
    })
  }
  if (lastReply) {
    lines.push('', `## ${ko ? 'Claude의 마지막 답변' : "Claude's last reply"}`, clamp(lastReply.body.trim(), HANDOFF_REPLY_CHARS))
  }
  const text = lines.join('\n')
  if (!opts.mask) return { text, masked: 0 }
  const r = redactSecrets(text)
  return { text: r.text, masked: r.count }
}

import type { DbHandle } from './db.js'
import { likePattern, parseIdList } from './search.js'
import type {
  FavoriteRow,
  ProjectRow,
  PromptQuery,
  PromptRow,
  RecentSessionRow,
  SessionInfo,
  SessionMessageRow,
  TagRow,
} from '../shared/ipc.js'

/** Read queries behind the IPC handlers. Heavy ones run on the query worker (see `queryWorker.ts`). */

export function listProjects(db: DbHandle): ProjectRow[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.slug, p.display_name AS displayName, p.root_path AS path, p.tool AS tool,
              p.archived_at AS archivedAt,
              COUNT(s.id) AS sessionCount,
              COUNT(s.archived_at) AS archivedCount,
              MAX(s.file_mtime_ms) AS lastModified
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id
       GROUP BY p.id
       ORDER BY (lastModified IS NULL) ASC, lastModified DESC, p.slug`,
    )
    .all() as (Omit<ProjectRow, 'archived'> & { archivedAt: number | null })[]
  return rows.map(({ archivedAt, ...r }) => ({ ...r, tool: r.tool ?? 'claude', archived: archivedAt != null }))
}

export function recentSessions(db: DbHandle, projectId: number | null, limit = 18): RecentSessionRow[] {
  const rows = db
    .prepare(
      `SELECT s.id AS sessionId,
              p.display_name AS projectName,
              s.rel_path AS sessionFile,
              s.file_mtime_ms AS mtime,
              s.archived_at IS NOT NULL AS archived,
              (SELECT substr(COALESCE(m2.prompt_text, m2.body), 1, 140) FROM messages m2
                WHERE m2.session_id = s.id AND m2.message_class != 'meta'
                ORDER BY m2.is_prompt DESC, m2.line_index ASC LIMIT 1) AS preview
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       -- Subagent transcripts are parts of a session, not sessions a person opened.
       WHERE (? IS NULL OR p.id = ?) AND s.rel_path NOT LIKE '%subagents%'
       ORDER BY s.file_mtime_ms DESC
       LIMIT ?`,
    )
    .all(projectId, projectId, Math.min(Math.max(Math.trunc(limit), 1), 200)) as (Omit<RecentSessionRow, 'archived'> & { archived: number })[]
  return rows.map((r) => ({ ...r, archived: Boolean(r.archived) }))
}

/**
 * A session's rows in line order. The default window is the first 25k rows; callers that
 * page (the transcript view, exports) pass `offset`/`limit` explicitly.
 */
export function sessionTranscript(
  db: DbHandle,
  sessionId: number,
  opts: { offset?: number; limit?: number } = {},
): SessionMessageRow[] {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 25000))
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
  const rows = db
    .prepare(
      `SELECT m.id AS messageId, m.msg_key AS msgKey, m.line_index AS lineIndex, m.role, m.body,
              COALESCE(m.message_class, 'dialog') AS messageClass,
              m.content_kinds AS contentKinds
       FROM messages m
       WHERE m.session_id = ?
       ORDER BY m.line_index ASC
       LIMIT ${limit} OFFSET ${offset}`,
    )
    .all(sessionId) as (Omit<SessionMessageRow, 'contentKinds'> & { contentKinds: string | null })[]
  return rows.map((r): SessionMessageRow => {
    let kinds: string[] = []
    try {
      const parsed = r.contentKinds ? JSON.parse(r.contentKinds) : []
      if (Array.isArray(parsed)) kinds = parsed.filter((k): k is string => typeof k === 'string')
    } catch {
      /* stored value is not valid JSON — treat as no kinds */
    }
    return { ...r, contentKinds: kinds }
  })
}

export function sessionInfo(db: DbHandle, sessionId: number): SessionInfo | null {
  const row = db
    .prepare(`SELECT id AS sessionId, file_path AS filePath, archived_at AS archivedAt FROM sessions WHERE id = ?`)
    .get(sessionId) as SessionInfo | undefined
  return row ?? null
}

export function messageBody(db: DbHandle, messageId: number): string {
  const row = db.prepare(`SELECT body FROM messages WHERE id = ?`).get(messageId) as { body: string } | undefined
  return row?.body ?? ''
}

/**
 * Distinct prompts I typed, grouped by exact text. A resumed or forked session copies
 * earlier lines (same uuid) into a new file, so uses count distinct `msg_key`s.
 */
export function listPrompts(db: DbHandle, q: PromptQuery): PromptRow[] {
  const where: string[] = ['m.is_prompt = 1']
  const params: (string | number)[] = []
  if (q.projectId != null) {
    where.push('s.project_id = ?')
    params.push(q.projectId)
  }
  const text = q.query.trim()
  if (text) {
    where.push(`m.prompt_text LIKE ? ESCAPE '\\'`)
    params.push(likePattern(text))
  }
  const order = q.sort === 'frequent' ? 'uses DESC, lastTsMs DESC' : '(lastTsMs IS NULL) ASC, lastTsMs DESC'
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 500)
  const groups = db
    .prepare(
      `SELECT m.prompt_text AS text, COUNT(DISTINCT m.msg_key) AS uses,
              MAX(m.ts_ms) AS lastTsMs, MIN(m.ts_ms) AS firstTsMs, MAX(m.id) AS messageId
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE ${where.join(' AND ')}
       GROUP BY m.prompt_text
       ORDER BY ${order}
       LIMIT ${limit}`,
    )
    .all(...params) as Pick<PromptRow, 'text' | 'uses' | 'lastTsMs' | 'firstTsMs' | 'messageId'>[]
  if (!groups.length) return []
  const detail = db.prepare(
    `SELECT m.msg_key AS msgKey, m.session_id AS sessionId, s.rel_path AS sessionFile, m.line_index AS lineIndex,
            p.display_name AS projectName, s.archived_at IS NOT NULL AS archived,
            EXISTS (SELECT 1 FROM favorites f WHERE f.msg_key = m.msg_key) AS isFavorite
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     JOIN projects p ON p.id = s.project_id
     WHERE m.id = ?`,
  )
  type Detail = Pick<PromptRow, 'msgKey' | 'sessionId' | 'sessionFile' | 'lineIndex' | 'projectName'> & {
    archived: number
    isFavorite: number
  }
  return groups.map((g) => {
    const d = detail.get(g.messageId) as Detail
    return { ...g, ...d, archived: Boolean(d.archived), isFavorite: Boolean(d.isFavorite) }
  })
}

// ── User data (favorites, tags) ─────────────────────────────────────────────

/** Snapshots are capped so one starred 5 MB tool dump can't bloat the user-data tables. */
const MAX_SNAPSHOT = 200_000

export function listFavorites(db: DbHandle): FavoriteRow[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.msg_key AS msgKey, f.body, f.role, f.project_label AS projectLabel,
              f.session_file AS sessionFile, f.created_at AS createdAt,
              m.id AS messageId, m.session_id AS sessionId, m.line_index AS lineIndex,
              (m.id IS NULL OR s.archived_at IS NOT NULL) AS archived,
              (SELECT group_concat(mt.tag_id) FROM message_tags mt WHERE mt.msg_key = f.msg_key) AS tagIds
       FROM favorites f
       LEFT JOIN messages m ON m.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.msg_key = f.msg_key)
       LEFT JOIN sessions s ON s.id = m.session_id
       ORDER BY f.created_at DESC`,
    )
    .all() as (Omit<FavoriteRow, 'archived' | 'tagIds'> & { archived: number; tagIds: string | null })[]
  return rows.map((r) => ({ ...r, archived: Boolean(r.archived), tagIds: parseIdList(r.tagIds) }))
}

export function addFavorite(db: DbHandle, messageId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO favorites (msg_key, created_at, body, role, project_label, session_file)
     SELECT m.msg_key, ?, substr(m.body, 1, ${MAX_SNAPSHOT}), m.role, p.display_name, s.rel_path
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     JOIN projects p ON p.id = s.project_id
     WHERE m.id = ?`,
  ).run(Date.now(), messageId)
}

export function removeFavorite(db: DbHandle, msgKey: string): void {
  db.prepare(`DELETE FROM favorites WHERE msg_key = ?`).run(msgKey)
}

export function listTags(db: DbHandle): TagRow[] {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color, (SELECT COUNT(*) FROM message_tags mt WHERE mt.tag_id = t.id) AS count
       FROM tags t ORDER BY t.name`,
    )
    .all() as TagRow[]
}

export function createTag(db: DbHandle, name: string, color: string | null): number {
  const existing = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as { id: number } | undefined
  if (existing) return existing.id
  return Number(db.prepare(`INSERT INTO tags (name, color) VALUES (?, ?)`).run(name, color).lastInsertRowid)
}

/** False when another tag already has the name. */
export function renameTag(db: DbHandle, id: number, name: string): boolean {
  const clash = db.prepare(`SELECT id FROM tags WHERE name = ? AND id != ?`).get(name, id)
  if (clash) return false
  db.prepare(`UPDATE tags SET name = ? WHERE id = ?`).run(name, id)
  return true
}

export function deleteTag(db: DbHandle, id: number): void {
  db.prepare(`DELETE FROM tags WHERE id = ?`).run(id)
}

export function setMessageTags(db: DbHandle, msgKey: string, tagIds: number[]): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM message_tags WHERE msg_key = ?`).run(msgKey)
    const ins = db.prepare(
      `INSERT OR IGNORE INTO message_tags (msg_key, tag_id) SELECT ?, id FROM tags WHERE id = ?`,
    )
    for (const tid of tagIds) ins.run(msgKey, tid)
  })()
}

/**
 * Explicitly drop sessions/projects/plans kept only as archives; returns how many sessions
 * and plans went. Favorites keep their snapshots.
 */
export function purgeArchived(db: DbHandle): number {
  const sessions = db.prepare(`DELETE FROM sessions WHERE archived_at IS NOT NULL`).run().changes
  db.prepare(`DELETE FROM projects WHERE archived_at IS NOT NULL`).run()
  const plans = db.prepare(`DELETE FROM plan_files WHERE archived_at IS NOT NULL`).run().changes
  return sessions + plans
}

/** Records that the app was used on `day` (local `YYYY-MM-DD`); once per day. */
export function recordAppOpen(db: DbHandle, day: string): void {
  db.prepare(`INSERT OR IGNORE INTO app_opens (day) VALUES (?)`).run(day)
}

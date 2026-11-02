import fs from 'node:fs'
import path from 'node:path'
import type { DbHandle } from './db.js'
import { getSetting } from './db.js'
import type { DiscoveredProject, LineParser, ToolAdapter } from './adapters.js'
import { fingerprint, readLines } from './lineReader.js'
import { basenameOf, parseJsonlLine } from '../shared/jsonlParse.js'

export { defaultClaudeProjectsRoot } from './claudeRoots.js'

/**
 * What happens to indexed rows when their source file disappears. `keep` (default)
 * marks them archived — Claude Code deletes old transcripts on its own schedule, and
 * keeping them is the point of a vault. `mirror` deletes them like the source.
 */
export type ArchiveMode = 'keep' | 'mirror'

export function archiveModeOf(db: DbHandle): ArchiveMode {
  return getSetting(db, 'archiveMode') === 'mirror' ? 'mirror' : 'keep'
}

/** Lines written per transaction — bounds how long the write lock is held. */
const BATCH_LINES = 2000

/** Lets a long file yield between batches so other work (stats, new events) interleaves. */
export type Yield = () => Promise<void>
const noYield: Yield = async () => {}

export function upsertProject(
  db: DbHandle,
  project: DiscoveredProject,
  tool: string,
): number {
  const mtime = fs.statSync(project.root).mtimeMs
  db.prepare(
    `INSERT INTO projects (slug, root_path, display_name, last_modified, tool, archived_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(slug) DO UPDATE SET
       root_path = excluded.root_path,
       -- A slug guess must not overwrite a title already refined from the transcripts.
       display_name = CASE WHEN ? THEN projects.display_name ELSE excluded.display_name END,
       last_modified = excluded.last_modified,
       tool = excluded.tool,
       archived_at = NULL`,
  ).run(project.slug, project.root, project.displayName, Math.trunc(mtime), tool, project.displayNameIsGuess ? 1 : 0)
  const row = db.prepare(`SELECT id FROM projects WHERE slug = ?`).get(project.slug) as { id: number }
  return row.id
}

/** Replace a slug-derived project title with the working directory its transcripts recorded. */
export function refineDisplayName(db: DbHandle, projectId: number, project: DiscoveredProject): void {
  if (!project.displayNameIsGuess) return
  const row = db
    .prepare(
      `SELECT m.cwd FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.project_id = ? AND m.cwd IS NOT NULL AND m.cwd != ''
       ORDER BY m.id DESC LIMIT 1`,
    )
    .get(projectId) as { cwd: string } | undefined
  if (row) db.prepare(`UPDATE projects SET display_name = ? WHERE id = ?`).run(row.cwd, projectId)
}

type SessionState = {
  id: number
  file_mtime_ms: number
  size_bytes: number
  indexed_bytes: number
  head_hash: string | null
  tail_hash: string | null
  message_count: number
  archived_at: number | null
}

export type IndexFileResult = { added: number; mode: 'skip' | 'append' | 'full' }

/** True when the file still holds the bytes this row was indexed from, plus maybe more. */
function hasOnlyGrown(row: SessionState, filePath: string, size: number): boolean {
  if (row.indexed_bytes <= 0 || !row.head_hash || size < row.indexed_bytes) return false
  const fp = fingerprint(filePath, row.indexed_bytes)
  return fp.head === row.head_hash && fp.tail === row.tail_hash
}

/**
 * Takes a session's row out of the way of the file now at its path. Its messages stay
 * where they are, archived under a path no file can have; repointing them at a new row
 * would rewrite every message through the FTS triggers for the same result.
 */
function setAsideSession(db: DbHandle, row: SessionState, filePath: string) {
  const taken = db.prepare(`SELECT 1 FROM sessions WHERE file_path = ?`)
  const now = Date.now()
  let ts = now
  while (taken.get(`${filePath}#archived-${ts}`)) ts += 1
  const suffix = `#archived-${ts}`
  db.prepare(
    `UPDATE sessions SET file_path = ?, rel_path = rel_path || ?, archived_at = COALESCE(archived_at, ?) WHERE id = ?`,
  ).run(filePath + suffix, suffix, now, row.id)
}

/**
 * Index one transcript file. Claude Code only ever appends to a session file, so a
 * file whose first bytes and whose bytes before the last indexed offset are unchanged
 * is resumed from that offset — an active 400 MB session costs a few new lines per
 * update instead of a full re-read. A stateful format that has only grown is re-read in
 * place. Any other file at this path is different content: its rows may be the only copy
 * left, so an archived session (and, in Keep mode, a live one) is set aside and the file
 * becomes a session of its own. Mirror mode replaces a live session's rows, and rows reset
 * by `requestFullReparse` are re-read in place. User data keyed on `msg_key` is untouched.
 */
export async function indexSessionFile(
  db: DbHandle,
  opts: {
    projectId: number
    projectRoot: string
    filePath: string
    createParser?: () => LineParser
    appendable?: boolean
    yieldNow?: Yield
  },
): Promise<IndexFileResult> {
  const { projectId, projectRoot, filePath } = opts
  const createParser = opts.createParser ?? (() => parseJsonlLine)
  const appendable = opts.appendable ?? true
  const yieldNow = opts.yieldNow ?? noYield

  const stat = fs.statSync(filePath)
  const mtime = Math.trunc(stat.mtimeMs)
  const size = stat.size
  const rel = path.relative(projectRoot, filePath)

  let row = db
    .prepare(
      `SELECT id, file_mtime_ms, size_bytes, indexed_bytes, head_hash, tail_hash, message_count, archived_at
       FROM sessions WHERE file_path = ?`,
    )
    .get(filePath) as SessionState | undefined

  // The common case on every scan: a live file that has not changed needs no hashing. An
  // archived row has to prove the file is the same one first, even at the same size and mtime.
  if (row && row.archived_at == null && row.indexed_bytes > 0 && row.indexed_bytes === size && row.file_mtime_ms === mtime) {
    return { added: 0, mode: 'skip' }
  }

  const grown = row != null && hasOnlyGrown(row, filePath, size)
  if (row && !grown && row.message_count > 0) {
    const fingerprinted = row.indexed_bytes > 0 && row.head_hash != null
    if (row.archived_at != null || (fingerprinted && archiveModeOf(db) === 'keep')) {
      setAsideSession(db, row, filePath)
      row = undefined
    }
  }
  if (row && row.archived_at != null) {
    // The source came back; it is live again.
    db.prepare(`UPDATE sessions SET archived_at = NULL WHERE id = ?`).run(row.id)
  }

  let start = 0
  let lineIndex = 0
  let mode: IndexFileResult['mode'] = 'full'
  if (row && appendable && grown) {
    start = row.indexed_bytes
    lineIndex = row.message_count
    mode = 'append'
  }
  if (mode === 'append' && start === size) {
    db.prepare(`UPDATE sessions SET file_mtime_ms = ? WHERE id = ?`).run(mtime, row!.id)
    return { added: 0, mode: 'skip' }
  }

  if (!row) {
    const info = db
      .prepare(
        `INSERT INTO sessions (project_id, rel_path, file_path, file_mtime_ms, message_count, size_bytes, indexed_bytes)
         VALUES (?, ?, ?, ?, 0, ?, 0)`,
      )
      .run(projectId, rel, filePath, mtime, size)
    row = {
      id: Number(info.lastInsertRowid),
      file_mtime_ms: mtime,
      size_bytes: size,
      indexed_bytes: 0,
      head_hash: null,
      tail_hash: null,
      message_count: 0,
      archived_at: null,
    }
  } else if (mode === 'full') {
    // Keep the session id stable (the UI may hold it); replace its rows.
    db.transaction(() => {
      db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(row!.id)
      db.prepare(
        `UPDATE sessions SET project_id = ?, rel_path = ?, message_count = 0, indexed_bytes = 0,
                head_hash = NULL, tail_hash = NULL WHERE id = ?`,
      ).run(projectId, rel, row!.id)
    })()
  }
  const sessionId = row.id

  const insMsg = db.prepare(
    `INSERT INTO messages
       (session_id, line_index, role, body, content_kinds, raw_preview, message_class,
        ts_ms, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cache_creation_1h_tokens, is_sidechain, cwd, git_branch, msg_key, api_msg_id, request_id,
        is_prompt, prompt_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insFileRef = db.prepare(`INSERT OR IGNORE INTO file_refs (message_id, path, basename) VALUES (?, ?, ?)`)
  const updSession = db.prepare(
    `UPDATE sessions SET indexed_bytes = ?, message_count = ?, size_bytes = ?, file_mtime_ms = ?,
            head_hash = ?, tail_hash = ? WHERE id = ?`,
  )

  const parse = createParser()
  let batch: { parsed: NonNullable<ReturnType<LineParser>>; idx: number }[] = []
  let consumed = start
  let added = 0

  const flush = () => {
    const end = consumed
    const fp = fingerprint(filePath, end)
    db.transaction(() => {
      for (const { parsed, idx } of batch) {
        const u = parsed.usage
        const info = insMsg.run(
          sessionId,
          idx,
          parsed.role,
          parsed.text || parsed.rawPreview || '',
          JSON.stringify(parsed.contentKinds),
          // Legacy column, never read: the body already holds the text (~100 MB on 5 GB).
          null,
          parsed.messageClass,
          parsed.tsMs,
          parsed.model,
          u?.inputTokens ?? null,
          u?.outputTokens ?? null,
          u?.cacheReadTokens ?? null,
          u?.cacheCreationTokens ?? null,
          u?.cacheCreation1hTokens ?? null,
          parsed.isSidechain ? 1 : 0,
          parsed.cwd,
          parsed.gitBranch,
          parsed.uuid ?? `${filePath}#${idx}`,
          parsed.apiMessageId,
          parsed.requestId,
          parsed.isPrompt ? 1 : 0,
          parsed.promptText,
        )
        if (parsed.filePaths.length) {
          const messageId = Number(info.lastInsertRowid)
          for (const p of parsed.filePaths) insFileRef.run(messageId, p, basenameOf(p))
        }
      }
      updSession.run(end, lineIndex, size, mtime, fp.head, fp.tail, sessionId)
    })()
    added += batch.length
    batch = []
  }

  for (const line of readLines(filePath, start)) {
    if (line.end > size) break // bytes written after our stat; next event picks them up
    const parsed = parse(line.text)
    if (line.partial && parsed?.contentKinds.includes('invalid_json')) break // still being written
    if (parsed) {
      batch.push({ parsed, idx: lineIndex })
      lineIndex += 1
    }
    consumed = line.end
    if (batch.length >= BATCH_LINES) {
      flush()
      await yieldNow()
    }
  }
  flush()
  return { added, mode }
}

/**
 * Reconcile rows whose backing file or directory is gone. Only runs for adapters
 * whose root exists — an unmounted volume or a wrong CLAUDE_HOME must never read as
 * "everything was deleted".
 */
export function reconcileMissing(db: DbHandle, adapter: ToolAdapter, mode: ArchiveMode): number {
  if (!adapter.isAvailable()) return 0
  const now = Date.now()
  let changed = 0
  const sessions = db
    .prepare(
      `SELECT s.id, s.file_path FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE p.tool = ? AND s.archived_at IS NULL`,
    )
    .all(adapter.id) as { id: number; file_path: string }[]
  const archive = db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`)
  const del = db.prepare(`DELETE FROM sessions WHERE id = ?`)
  for (const s of sessions) {
    if (fs.existsSync(s.file_path)) continue
    if (mode === 'keep') archive.run(now, s.id)
    else del.run(s.id)
    changed += 1
  }
  const projects = db
    .prepare(`SELECT id, root_path FROM projects WHERE tool = ? AND archived_at IS NULL`)
    .all(adapter.id) as { id: number; root_path: string }[]
  for (const p of projects) {
    if (fs.existsSync(p.root_path)) continue
    if (mode === 'keep') db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`).run(now, p.id)
    else db.prepare(`DELETE FROM projects WHERE id = ?`).run(p.id)
    changed += 1
  }
  return changed
}

/**
 * A transcript file was deleted: archive or drop its session per the archive setting. A
 * row already archived stays as it is, in mirror mode too: only a purge removes those.
 */
export function handleSessionUnlink(db: DbHandle, filePath: string, mode: ArchiveMode): boolean {
  const row = db.prepare(`SELECT id FROM sessions WHERE file_path = ? AND archived_at IS NULL`).get(filePath) as
    | { id: number }
    | undefined
  if (!row) return false
  if (mode === 'keep') db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(Date.now(), row.id)
  else db.prepare(`DELETE FROM sessions WHERE id = ?`).run(row.id)
  return true
}

/** Index one project discovered by a tool adapter; returns how many session files it holds. */
export async function indexAdapterProject(
  db: DbHandle,
  adapter: ToolAdapter,
  project: DiscoveredProject,
  yieldNow: Yield = noYield,
): Promise<number> {
  const pid = upsertProject(db, project, adapter.id)
  const files = adapter.listSessions(project)
  for (const f of files) {
    try {
      await indexSessionFile(db, {
        projectId: pid,
        projectRoot: project.root,
        filePath: f,
        createParser: adapter.createParser,
        appendable: adapter.appendable,
        yieldNow,
      })
    } catch (err) {
      // One unreadable file must not stop the rest of the scan.
      console.error('[vault] failed to index', f, err)
    }
    await yieldNow()
  }
  refineDisplayName(db, pid, project)
  db.prepare(`UPDATE projects SET last_indexed_at = ? WHERE id = ?`).run(Date.now(), pid)
  return files.length
}

/** Live update for one transcript path; resolves the owning adapter and project from the path. */
export async function indexSinglePath(
  db: DbHandle,
  adapters: ToolAdapter[],
  absoluteFilePath: string,
  yieldNow: Yield = noYield,
): Promise<boolean> {
  const normalized = path.normalize(absoluteFilePath)
  if (!normalized.toLowerCase().endsWith('.jsonl') || !fs.existsSync(normalized)) return false
  for (const adapter of adapters) {
    const project = adapter.projectForFile(normalized)
    if (!project) continue
    const pid = upsertProject(db, project, adapter.id)
    const res = await indexSessionFile(db, {
      projectId: pid,
      projectRoot: project.root,
      filePath: normalized,
      createParser: adapter.createParser,
      appendable: adapter.appendable,
      yieldNow,
    })
    refineDisplayName(db, pid, project)
    db.prepare(`UPDATE projects SET last_indexed_at = ? WHERE id = ?`).run(Date.now(), pid)
    return res.mode !== 'skip'
  }
  return false
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { getSetting, openVaultDb, readSchemaVersion, SCHEMA_VERSION, type DbHandle } from './db.js'
import { handoffPrompt, listSessions, sessionDetail } from './sessions.js'
import { parseDay } from '../shared/searchSyntax.js'
import { redactSecrets } from '../shared/redact.js'
import { fileTimeline, listFiles } from './files.js'
import { listProjects, listPrompts, recentSessions, sessionTranscript } from './queries.js'
import { likePattern, searchMessages } from './search.js'
import type { SearchHit } from '../shared/ipc.js'

/**
 * Local MCP server (ADR-0011): lets Claude Code query the Trove vault — including
 * sessions Claude Code itself has since deleted — over stdio. No Electron APIs: it runs
 * as `node dist-electron/mcpServer.cjs` or, packaged, under the app binary with
 * `ELECTRON_RUN_AS_NODE=1`. The DB is opened read-only (`migrate: false` +
 * `query_only`); stdout carries only protocol messages, logs go to stderr.
 */

export const PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05']

/** Longest message body a tool returns; full transcripts can hold megabytes of tool output. */
export const BODY_CLAMP = 4000
const TOOL_CLAMP = 300

type JsonRpcId = string | number | null
type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } }

export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

/** A bad argument the caller can fix: reported as a tool error, not a protocol error. */
class ToolInputError extends Error {}

// ── Formatting helpers ──────────────────────────────────────────────────────

export function clamp(text: string, max = BODY_CLAMP): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [+${text.length - max} chars]`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local `YYYY-MM-DD HH:MM`, or `?` without a timestamp. */
export function fmtTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '?'
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// ── Argument helpers ────────────────────────────────────────────────────────

type Args = Record<string, unknown>

function str(args: Args, key: string, required = false): string | undefined {
  const v = args[key]
  if (v == null || v === '') {
    if (required) throw new ToolInputError(`"${key}" is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string`)
  return v
}

function int(args: Args, key: string, def: number, min: number, max: number): number {
  const v = args[key]
  if (v == null) return def
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolInputError(`"${key}" must be a number`)
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/** Projects whose display name contains `needle`, case-insensitively. */
export function matchProjects(db: DbHandle, needle: string): { id: number; name: string }[] {
  const n = needle.toLowerCase()
  return listProjects(db)
    .filter((p) => p.displayName.toLowerCase().includes(n))
    .map((p) => ({ id: p.id, name: p.displayName }))
}

/**
 * `undefined` = no project filter; otherwise the matching project ids. Throws a tool
 * error when nothing matches, so the model learns the name was wrong rather than
 * getting an empty answer.
 */
function projectScope(db: DbHandle, args: Args): number[] | undefined {
  const p = str(args, 'project')
  if (p == null) return undefined
  const ids = matchProjects(db, p).map((m) => m.id)
  if (!ids.length) throw new ToolInputError(`No project name contains "${p}". Call list_recent_sessions to see project names.`)
  return ids
}

// ── Tools ───────────────────────────────────────────────────────────────────

const PROJECT_PROP = {
  type: 'string',
  description: 'Case-insensitive substring of the project name (usually its folder path).',
}

export const TOOLS = [
  {
    name: 'search_history',
    description:
      'Full-text search over every Claude Code (and Codex) conversation Trove has indexed, including sessions Claude Code has already deleted (marked [archived]). Returns matching messages with session id and line; use get_session to read around a hit.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find. "quoted text" matches an exact phrase.' },
        project: PROJECT_PROP,
        role: { type: 'string', enum: ['user', 'assistant'], description: 'Only messages from this side.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        include_tools: { type: 'boolean', default: false, description: 'Also search tool calls and tool output.' },
        branch: { type: 'string', description: 'Substring of the git branch the message was written on.' },
        archived_only: { type: 'boolean', default: false, description: 'Only sessions Claude Code has deleted.' },
        after: { type: 'string', description: 'Only messages on or after this local date (YYYY-MM-DD, YYYY-MM or YYYY).' },
        before: { type: 'string', description: 'Only messages on or before this local date (YYYY-MM-DD, YYYY-MM or YYYY).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_sessions',
    description:
      'List sessions (not single messages) by title, first prompt, folder or branch, newest first. Good for "the session where I worked on X" when the exact words are unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring of the title, a prompt, the folder or the branch. Omit to list the latest.' },
        project: PROJECT_PROP,
        archived_only: { type: 'boolean', default: false, description: 'Only sessions Claude Code has deleted.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
      },
    },
  },
  {
    name: 'session_context',
    description:
      'A compact brief of one session — title, folder, branch, files touched, every prompt the user typed in order, and the last reply — for continuing work that can no longer be resumed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: ['integer', 'string'],
          description: 'Trove session id from another tool, or a Claude Code session UUID.',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_session',
    description:
      'Read one session transcript in order (bookkeeping lines skipped, tool calls abbreviated). Page with from_line.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: ['integer', 'string'],
          description: 'Trove session id from another tool, or a Claude Code session UUID.',
        },
        from_line: { type: 'integer', minimum: 0, default: 0, description: 'First transcript line to return.' },
        max_messages: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'list_recent_sessions',
    description: 'Most recently active sessions, newest first, with their first prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
      },
    },
  },
  {
    name: 'list_prompts',
    description: 'Prompts the user typed themselves (not tool output), grouped by exact text, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring the prompt must contain.' },
        project: PROJECT_PROP,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      },
    },
  },
  {
    name: 'file_history',
    description:
      'Sessions that read, edited or mentioned a file, newest first. Takes a full path or a part of one (e.g. a file name).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, or a substring such as the file name.' },
      },
      required: ['path'],
    },
  },
] as const

function hitLine(i: number, h: SearchHit): string {
  const flags = h.archived ? ' [archived]' : ''
  return `[${i + 1}] ${h.projectName} · session ${h.sessionId} · line ${h.lineIndex} · ${fmtTime(h.tsMs)} · ${h.role}${flags}\n    ${clamp(oneLine(h.snippet || h.body), 600)}`
}

function searchHistory(db: DbHandle, args: Args): string {
  const query = str(args, 'query', true)!
  const limit = int(args, 'limit', 20, 1, 50)
  const roleArg = str(args, 'role')
  if (roleArg != null && roleArg !== 'user' && roleArg !== 'assistant') {
    throw new ToolInputError('"role" must be "user" or "assistant"')
  }
  const day = (key: string, end: boolean): number | undefined => {
    const v = str(args, key)
    if (v == null) return undefined
    const ms = parseDay(v.trim(), end)
    if (ms == null) throw new ToolInputError(`"${key}" must be a date like 2026-10-01, 2026-10 or 2026`)
    return ms
  }
  const base = {
    query,
    limit,
    role: (roleArg ?? '') as 'user' | 'assistant' | '',
    excludeTools: args.include_tools !== true,
    excludeMeta: true,
    scope: 'messages' as const,
    branch: str(args, 'branch'),
    archived: args.archived_only === true ? ('archived' as const) : undefined,
    sinceMs: day('after', false),
    untilMs: day('before', true),
  }
  const projects = projectScope(db, args)
  let hits: SearchHit[]
  if (!projects) hits = searchMessages(db, base)
  else {
    // One search per matching project; bm25 ranks share one FTS table, so they merge.
    hits = projects.flatMap((projectId) => searchMessages(db, { ...base, projectId }))
    hits.sort((a, b) => a.rank - b.rank || (b.tsMs ?? 0) - (a.tsMs ?? 0))
    hits = hits.slice(0, limit)
  }
  if (!hits.length) return `No messages match "${query}".`
  return [`${hits.length} hit(s) for "${query}":`, ...hits.map((h, i) => hitLine(i, h))].join('\n')
}

type SessionHead = { id: number; filePath: string; relPath: string; archivedAt: number | null; projectName: string }

function findSession(db: DbHandle, raw: unknown): SessionHead | null {
  const head = `SELECT s.id, s.file_path AS filePath, s.rel_path AS relPath, s.archived_at AS archivedAt,
                       p.display_name AS projectName
                FROM sessions s JOIN projects p ON p.id = s.project_id`
  const asNum = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : null
  if (asNum != null) {
    return (db.prepare(`${head} WHERE s.id = ?`).get(asNum) as SessionHead | undefined) ?? null
  }
  if (typeof raw !== 'string' || raw.trim().length < 8) {
    throw new ToolInputError('"session_id" must be a Trove session id (number) or a session UUID')
  }
  // A Claude Code session id is the transcript's file name.
  return (
    (db
      .prepare(`${head} WHERE s.rel_path LIKE ? ESCAPE '\\' ORDER BY (s.archived_at IS NULL) DESC, s.file_mtime_ms DESC LIMIT 1`)
      .get(likePattern(raw.trim())) as SessionHead | undefined) ?? null
  )
}

function getSession(db: DbHandle, args: Args): string {
  if (args.session_id == null || args.session_id === '') throw new ToolInputError('"session_id" is required')
  const s = findSession(db, args.session_id)
  if (!s) return `No session ${JSON.stringify(args.session_id)} in the vault.`
  const from = int(args, 'from_line', 0, 0, Number.MAX_SAFE_INTEGER)
  const max = int(args, 'max_messages', 200, 1, 500)
  // Read in windows from `from_line`: a long session has tens of thousands of rows, and
  // most are bookkeeping that is skipped, so one window may not fill a page.
  const start = (
    db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND line_index < ?`).get(s.id, from) as { c: number }
  ).c
  const rows: ReturnType<typeof sessionTranscript> = []
  let offset = start
  let more = false
  for (;;) {
    const chunk = sessionTranscript(db, s.id, { offset, limit: 2000 })
    for (const r of chunk) {
      if (r.messageClass === 'meta') continue
      if (rows.length === max) {
        more = true
        break
      }
      rows.push(r)
    }
    if (more || chunk.length < 2000) break
    offset += chunk.length
  }
  const page = rows
  const d = sessionDetail(db, s.id)
  const out = [
    `Session ${s.id} · ${s.projectName} · ${s.relPath}${s.archivedAt != null ? ` · [archived ${fmtTime(s.archivedAt)}: source file deleted]` : ''}`,
  ]
  if (d) {
    if (d.title) out.push(`Title: ${d.title}`)
    if (d.cwd || d.gitBranch) out.push(`Folder: ${d.cwd ?? '?'}${d.gitBranch ? ` · branch ${d.gitBranch}` : ''}`)
    out.push(`Period: ${fmtTime(d.firstTsMs)} – ${fmtTime(d.lastTsMs)} · ${d.promptCount} prompt(s) · ${d.messageCount} line(s)`)
    if (d.resumeCommand && d.archivedAt == null) out.push(`Resume in a terminal: ${d.resumeCommand}`)
  }
  for (const r of page) {
    const isTool = r.role === 'tool' || r.contentKinds.includes('tool_use') || r.contentKinds.includes('tool_result')
    const body = isTool ? clamp(oneLine(r.body), TOOL_CLAMP) : clamp(r.body.trim())
    out.push(`\n--- line ${r.lineIndex} · ${isTool ? `${r.role} (tool)` : r.role}\n${body}`)
  }
  if (!page.length) out.push(`\n(no messages from line ${from})`)
  if (more) out.push(`\n… more messages follow. Continue with from_line=${page[page.length - 1].lineIndex + 1}.`)
  return out.join('\n')
}

function listRecentSessions(db: DbHandle, args: Args): string {
  const limit = int(args, 'limit', 15, 1, 50)
  const projects = projectScope(db, args)
  const rows = (projects ?? [null])
    .flatMap((pid) => recentSessions(db, pid, limit))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
  if (!rows.length) return 'No sessions in the vault.'
  return rows
    .map(
      (r) =>
        `session ${r.sessionId} · ${r.projectName} · ${fmtTime(r.mtime)}${r.archived ? ' [archived]' : ''}\n    ${clamp(oneLine(r.preview ?? ''), 200)}`,
    )
    .join('\n')
}

function listPromptsTool(db: DbHandle, args: Args): string {
  const query = str(args, 'query') ?? ''
  const limit = int(args, 'limit', 30, 1, 100)
  const projects = projectScope(db, args)
  const rows = (projects ?? [undefined])
    .flatMap((projectId) => listPrompts(db, { query, projectId, sort: 'recent', limit }))
    .sort((a, b) => (b.lastTsMs ?? 0) - (a.lastTsMs ?? 0))
    .slice(0, limit)
  if (!rows.length) return query ? `No prompts contain "${query}".` : 'No prompts in the vault.'
  return rows
    .map(
      (r) =>
        `${fmtTime(r.lastTsMs)} · ${r.projectName} · session ${r.sessionId} · line ${r.lineIndex}${r.uses > 1 ? ` · used ${r.uses}×` : ''}${r.archived ? ' [archived]' : ''}\n    ${clamp(r.text.trim(), 1000).replace(/\n/g, '\n    ')}`,
    )
    .join('\n')
}

function fileHistory(db: DbHandle, args: Args): string {
  const query = str(args, 'path', true)!.trim()
  let target = query
  if (!db.prepare(`SELECT 1 FROM file_refs WHERE path = ? LIMIT 1`).get(query)) {
    const candidates = listFiles(db, query, 20)
    if (!candidates.length) return `No indexed session touched a file matching "${query}".`
    if (candidates.length > 1) {
      return [
        `${candidates.length} files match "${query}" — call again with one exact path:`,
        ...candidates.map((c) => `  ${c.path} · ${c.sessions} session(s) · last ${fmtTime(c.lastTouched)}`),
      ].join('\n')
    }
    target = candidates[0].path
  }
  const touches = fileTimeline(db, target)
  const archived = db.prepare(`SELECT archived_at IS NOT NULL AS a FROM sessions WHERE id = ?`)
  const bySession = new Map<number, typeof touches>()
  for (const t of touches) {
    const list = bySession.get(t.sessionId)
    if (list) list.push(t)
    else bySession.set(t.sessionId, [t])
  }
  const out = [`${target} — ${touches.length} touch(es) in ${bySession.size} session(s), newest first:`]
  for (const [sessionId, list] of bySession) {
    const latest = list[0]
    const isArchived = (archived.get(sessionId) as { a: number } | undefined)?.a === 1
    out.push(
      `session ${sessionId} · ${latest.projectName} · ${fmtTime(latest.tsMs)}${latest.gitBranch ? ` · ${latest.gitBranch}` : ''} · ${list.length}× · lines ${list
        .map((t) => t.lineIndex)
        .sort((a, b) => a - b)
        .join(', ')}${isArchived ? ' [archived]' : ''}\n    ${clamp(oneLine(latest.preview), 200)}`,
    )
  }
  return out.join('\n')
}

function findSessionsTool(db: DbHandle, args: Args): string {
  const query = str(args, 'query') ?? ''
  const limit = int(args, 'limit', 15, 1, 50)
  const projects = projectScope(db, args)
  const archived = args.archived_only === true ? ('archived' as const) : 'all'
  const rows = (projects ?? [undefined])
    .flatMap((projectId) => listSessions(db, { query, projectId, archived, limit }).rows)
    .sort((a, b) => (b.lastTsMs ?? b.mtime) - (a.lastTsMs ?? a.mtime))
    .slice(0, limit)
  if (!rows.length) return query ? `No session matches "${query}".` : 'No sessions in the vault.'
  return rows
    .map((r) => {
      const head = `session ${r.sessionId} · ${r.projectName} · ${fmtTime(r.lastTsMs ?? r.mtime)}${r.gitBranch ? ` · ${r.gitBranch}` : ''} · ${r.messageCount} line(s)${r.subagentCount ? ` · ${r.subagentCount} subagent(s)` : ''}${r.archived ? ' [archived]' : ''}`
      const title = r.title ? `\n    Title: ${clamp(oneLine(r.title), 200)}` : ''
      const first = r.preview ? `\n    First prompt: ${clamp(oneLine(r.preview), 200)}` : ''
      return head + title + first
    })
    .join('\n')
}

function sessionContextTool(db: DbHandle, args: Args): string {
  if (args.session_id == null || args.session_id === '') throw new ToolInputError('"session_id" is required')
  const s = findSession(db, args.session_id)
  if (!s) return `No session ${JSON.stringify(args.session_id)} in the vault.`
  // Masking happens once for every tool result (see handleRequest).
  return handoffPrompt(db, s.id, { mask: false, locale: 'en' }).text
}

const TOOL_IMPL: Record<string, (db: DbHandle, args: Args) => string> = {
  find_sessions: findSessionsTool,
  session_context: sessionContextTool,
  search_history: searchHistory,
  get_session: getSession,
  list_recent_sessions: listRecentSessions,
  list_prompts: listPromptsTool,
  file_history: fileHistory,
}

// ── JSON-RPC dispatch ───────────────────────────────────────────────────────

const INSTRUCTIONS =
  "Trove is the user's local archive of past Claude Code and Codex sessions, including ones Claude Code has deleted. " +
  'Use search_history to find earlier discussions, find_sessions to find a session by its title or topic, get_session to read one, ' +
  'session_context for a compact brief to continue an old session, list_prompts for what the user asked before, ' +
  'and file_history to see which sessions worked on a file. Read-only; secrets are masked unless the user turned that off.'

export type ServerInfo = { name: string; version: string }

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * One incoming JSON-RPC message → its response, or null for a notification (nothing
 * is sent back). Pure apart from reading `db`, so tests drive it directly.
 */
export function handleRequest(
  db: DbHandle,
  msg: unknown,
  info: ServerInfo = { name: 'trove', version: '0' },
): JsonRpcResponse | null {
  if (typeof msg !== 'object' || msg == null || Array.isArray(msg)) {
    return fail(null, RPC_ERROR.invalidRequest, 'Invalid Request')
  }
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  const hasId = 'id' in m && m.id !== undefined
  const id: JsonRpcId = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    // A response from the client (we never send requests) or garbage.
    if (!('method' in m) && ('result' in m || 'error' in m)) return null
    return fail(id, RPC_ERROR.invalidRequest, 'Invalid Request')
  }
  if (!hasId) return null // notifications: notifications/initialized, cancelled, …
  const params = (typeof m.params === 'object' && m.params != null ? m.params : {}) as Record<string, unknown>

  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION
      return ok(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: info,
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS })
    case 'tools/call': {
      const name = params.name
      const impl = typeof name === 'string' ? TOOL_IMPL[name] : undefined
      if (!impl) return fail(id, RPC_ERROR.invalidParams, `Unknown tool: ${String(name)}`)
      const args = (typeof params.arguments === 'object' && params.arguments != null ? params.arguments : {}) as Args
      try {
        // Tool results reach the model: the app's "Mask secrets" setting applies here too.
        const raw = impl(db, args)
        const text = getSetting(db, 'maskSecrets') === 'off' ? raw : redactSecrets(raw).text
        const result: ToolResult = { content: [{ type: 'text', text }] }
        return ok(id, result)
      } catch (err) {
        if (!(err instanceof ToolInputError)) console.error(`[trove-mcp] ${String(name)} failed:`, err)
        const result: ToolResult = {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        }
        return ok(id, result)
      }
    }
    default:
      return fail(id, RPC_ERROR.methodNotFound, `Method not found: ${m.method}`)
  }
}

// ── Process entry ───────────────────────────────────────────────────────────

/** Path rules of the platform a path is for, not of the one this code runs on. */
const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)

/** Where the app keeps `vault.db` (Electron's userData for the "Trove" product name). */
export function defaultDbPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const p = pathFor(platform)
  const appData =
    platform === 'darwin'
      ? p.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? env.APPDATA || p.join(home, 'AppData', 'Roaming')
        : env.XDG_CONFIG_HOME || p.join(home, '.config')
  return p.join(appData, 'Trove', 'vault.db')
}

/** `--db <path>` / `--db=<path>`, then `TROVE_DB`, then the app's default location. */
export function resolveDbPath(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1]) return path.resolve(argv[i + 1])
    if (argv[i].startsWith('--db=')) return path.resolve(argv[i].slice(5))
  }
  if (env.TROVE_DB?.trim()) return path.resolve(env.TROVE_DB.trim())
  return defaultDbPath(process.platform, env)
}

/** How to start this server from outside: shown in Settings for `claude mcp add`. */
export type McpLaunch = { command: string; args: string[]; env: Record<string, string>; claudeAddLine: string }

function shellQuote(s: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s
  if (platform === 'win32') return `"${s.replace(/"/g, '\\"')}"`
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function mcpLaunch(opts: {
  packaged: boolean
  execPath: string
  appPath: string
  dbFile: string
  platform?: NodeJS.Platform
}): McpLaunch {
  const platform = opts.platform ?? process.platform
  const script = pathFor(platform).join(opts.appPath, 'dist-electron', 'mcpServer.cjs')
  // Packaged: the app binary is a Node runtime with ELECTRON_RUN_AS_NODE, and reads
  // the script (and better-sqlite3's unpacked .node) through app.asar.
  const command = opts.packaged ? opts.execPath : 'node'
  const env: Record<string, string> = opts.packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  const args = [script, '--db', opts.dbFile]
  const q = (s: string) => shellQuote(s, platform)
  const envFlags = Object.entries(env).map(([k, v]) => ` --env ${k}=${v}`)
  const claudeAddLine = `claude mcp add trove --scope user${envFlags.join('')} -- ${[command, ...args].map(q).join(' ')}`
  return { command, args, env, claudeAddLine }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0'
  } catch {
    return '0'
  }
}

/**
 * Opens the vault read-only and serves stdin/stdout until stdin closes. Exits with 1
 * (after saying why on stderr) when the DB is missing: this process never creates or
 * migrates it — only the app does.
 */
export function runMcpServer(opts: { dbFile?: string; version?: string; exit?: (code: number) => void } = {}): void {
  // Default: let the process end on its own, so stdout (asynchronous for pipes on macOS)
  // drains before it does.
  const exit =
    opts.exit ??
    ((code: number) => {
      process.exitCode = code
    })
  const dbFile = opts.dbFile ?? resolveDbPath()
  if (!fs.existsSync(dbFile)) {
    console.error(
      `[trove-mcp] No Trove database at ${dbFile}. Open the Trove app once to build it, or pass --db <path> / set TROVE_DB.`,
    )
    exit(1)
    return
  }
  let db: DbHandle
  try {
    db = openVaultDb(dbFile, { migrate: false })
    db.pragma('query_only = ON')
    const v = readSchemaVersion(db)
    if (v === 0) throw new Error('not a Trove database (no schema version)')
    if (v !== SCHEMA_VERSION) {
      console.error(`[trove-mcp] database is schema v${v}, this server expects v${SCHEMA_VERSION}; some tools may fail`)
    }
  } catch (err) {
    console.error(`[trove-mcp] cannot open ${dbFile}:`, err instanceof Error ? err.message : err)
    exit(1)
    return
  }
  const info: ServerInfo = { name: 'trove', version: opts.version ?? readVersion() }
  console.error(`[trove-mcp] serving ${dbFile} (read-only)`)

  const send = (res: JsonRpcResponse) => process.stdout.write(`${JSON.stringify(res)}\n`)
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      send(fail(null, RPC_ERROR.parse, 'Parse error'))
      return
    }
    let res: JsonRpcResponse | null
    try {
      res = handleRequest(db, msg, info)
    } catch (err) {
      const id = (msg as { id?: unknown })?.id
      res = fail(typeof id === 'string' || typeof id === 'number' ? id : null, RPC_ERROR.internal, String(err))
    }
    if (res) send(res)
  })
  rl.on('close', () => {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    exit(0)
  })
}

// Started directly (`node mcpServer.cjs`, or the app binary with ELECTRON_RUN_AS_NODE):
// serve. Imported by main.ts (`--mcp`) or tests: do nothing until asked.
if (/mcpServer\.(c?js|ts)$/.test(process.argv[1] ?? '')) runMcpServer()

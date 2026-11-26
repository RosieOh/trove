export type ContentPart =
  | { type: string; text?: string }
  | { type: 'tool_use'; name?: string; input?: unknown }
  | Record<string, unknown>

/** dialog: 일반 대화 / meta: 권한·제목 등 시스템 메타 / other: 분류 어려움 */
export type MessageClass = 'dialog' | 'meta' | 'other'

/** Token usage extracted from an assistant line's `message.usage`. */
export type UsageTokens = {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  /** Subset of `cacheCreationTokens` written with the 1-hour TTL (priced higher than 5-minute writes). */
  cacheCreation1hTokens: number | null
}

export type ParsedLine = {
  role: string
  text: string
  contentKinds: string[]
  rawPreview: string
  messageClass: MessageClass
  /** Epoch ms parsed from the line's ISO `timestamp`, or null when absent/unparsable. */
  tsMs: number | null
  /** Model id from `message.model` (assistant lines), or null. */
  model: string | null
  /** Token usage from `message.usage`, or null when the line carries none. */
  usage: UsageTokens | null
  /** `isSidechain` flag — Claude Code marks subagent/side-thread lines true. */
  isSidechain: boolean
  /** File paths this line's tool calls touched (empty for plain dialog). */
  filePaths: string[]
  /** Working directory / git branch recorded on the line, when present. */
  cwd: string | null
  gitBranch: string | null
  /** Line `uuid` — stable across re-indexing, so user data (favorites, tags) can key on it. */
  uuid: string | null
  /**
   * API response identity (`message.id` + `requestId`). Claude Code writes one line per
   * content block of a response and repeats `usage` on each, so token totals must be
   * counted once per response, not once per line.
   */
  apiMessageId: string | null
  requestId: string | null
  /** True when the line is something the human actually typed (not tool output or harness text). */
  isPrompt: boolean
  /** The prompt as typed, with IDE/harness wrappers removed; null unless `isPrompt`. */
  promptText: string | null
  /**
   * A session title this line sets: `custom-title` (the user's /rename) outranks
   * `ai-title`, which outranks a legacy `summary`. Absent on other lines.
   */
  sessionTitle?: SessionTitle | null
}

/** Rank decides which title wins when a session carries several: 3 custom, 2 ai, 1 summary. */
export type SessionTitle = { text: string; rank: 1 | 2 | 3 }

/** The title a line sets, if any. */
export function sessionTitleOf(obj: Record<string, unknown>): SessionTitle | null {
  const type = str(obj.type)
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 300) : '')
  if (type === 'custom-title') {
    const t = clean(obj.customTitle) || clean(obj.title)
    return t ? { text: t, rank: 3 } : null
  }
  if (type === 'ai-title') {
    const t = clean(obj.aiTitle) || clean(obj.title)
    return t ? { text: t, rank: 2 } : null
  }
  if (type === 'summary') {
    const t = clean(obj.summary)
    return t ? { text: t, rank: 1 } : null
  }
  return null
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

const AUX_META_KINDS = new Set([
  'thinking',
])

/** Kinds that usually represent UI/system metadata rather than user chat. */
const META_KINDS = new Set([
  'permission-mode',
  'agent-name',
  'custom-title',
  'session-id',
  'model-info',
  'version-info',
  'pricing',
  'rate-limits',
  'context-compact',
  'summary',
  'stop-reason',
  'citations',
])

/**
 * Top-level `type` values that are Claude Code bookkeeping, not conversation
 * (queue bookkeeping, file snapshots, mode switches…). These lines carry no
 * `message.content`, so without special handling their raw JSON would be stored
 * as the message body and shown as if it were dialog.
 */
const OPERATIONAL_TYPES = new Set([
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'attachment',
  'mode',
  'frame-link',
  'permission-mode',
  'last-prompt',
  'ai-title',
  'pr-link',
  'custom-title',
  'session-id',
  'model-info',
  'version-info',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'atis-latch',
  'bridge-session',
  'history-suppression',
  'started',
  'summary',
])

/**
 * Top-level `type` values that are conversation. Any other typed line is Claude Code
 * bookkeeping — even when it carries a `message` (e.g. `api-request-blob` stores a copy
 * of an internal API request) — so it must never surface as dialog. Untyped lines are
 * the legacy `{ role, message }` shape and are classified by content as before.
 */
const CONVERSATION_TYPES = new Set(['user', 'assistant', 'system'])

/** Internal payload copies can be huge; keep them inspectable without bloating the index. */
const MAX_BOOKKEEPING_BODY = 4000

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Short human-readable label for a content-less bookkeeping line. */
export function operationalLabel(obj: Record<string, unknown>, type: string): string {
  switch (type) {
    case 'queue-operation': {
      const op = str(obj.operation)
      return op ? `[대기열] ${op}` : '[대기열]'
    }
    case 'file-history-snapshot':
      return '[파일 스냅샷]'
    case 'file-history-delta':
      return '[파일 변경 기록]'
    case 'attachment': {
      const a = obj.attachment
      const kind = a && typeof a === 'object' ? str((a as Record<string, unknown>).type) : ''
      return kind ? `[첨부] ${kind}` : '[첨부]'
    }
    case 'mode': {
      const m = str(obj.mode)
      return m ? `[모드] ${m}` : '[모드]'
    }
    case 'frame-link':
      return '[프레임 링크]'
    case 'last-prompt':
      return '[최근 프롬프트 참조]'
    case 'ai-title': {
      const t = str(obj.aiTitle) || str(obj.title)
      return t ? `[제목] ${t}` : '[제목]'
    }
    case 'custom-title': {
      const t = str(obj.customTitle) || str(obj.title)
      return t ? `[제목] ${t}` : '[제목]'
    }
    case 'summary': {
      const t = str(obj.summary)
      return t ? `[요약] ${t}` : '[요약]'
    }
    case 'pr-link': {
      const n = obj.prNumber
      const url = str(obj.prUrl)
      const num = typeof n === 'number' ? `#${n}` : ''
      return `[PR] ${num} ${url}`.replace(/\s+/g, ' ').trim()
    }
    default:
      return `[${type}]`
  }
}

function textFromLastPromptPart(item: Record<string, unknown>): string | null {
  if (item.type !== 'last-prompt') return null
  const lp = item.lastPrompt
  return typeof lp === 'string' && lp.trim().length > 0 ? lp : null
}

function summarizeMetaPart(item: Record<string, unknown>, t: string): string {
  switch (t) {
    case 'permission-mode': {
      const pm = item.permissionMode
      return typeof pm === 'string' ? `[권한 모드] ${pm}` : '[권한 모드]'
    }
    case 'agent-name': {
      const n = (item.agentName ?? item.name) as unknown
      return typeof n === 'string' ? `[에이전트] ${n}` : '[에이전트]'
    }
    case 'custom-title': {
      const title = (item.title ?? item.customTitle) as unknown
      return typeof title === 'string' ? `[제목] ${title}` : '[제목]'
    }
    case 'session-id': {
      const sid = item.sessionId
      return typeof sid === 'string' ? `[세션] ${sid.slice(0, 8)}…` : '[세션]'
    }
    default:
      return `[${t}]`
  }
}

/** Input keys whose values are file paths across Claude Code's tool set. */
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path'])

/** Ignore transient/system paths — they add noise without answering "what did I work on". */
const PATH_NOISE = /(node_modules|[\\/]\.git[\\/]|__pycache__|[\\/]dist[\\/]|[\\/]build[\\/]|AppData[\\/]Local[\\/]Temp|[\\/]tmp[\\/])/i

/**
 * Collect file paths a tool call touched, so sessions can be looked up by file
 * ("when did I last work on App.tsx?"). Walks nested inputs because tools like
 * MultiEdit carry `edits[].file_path`.
 */
export function extractFilePaths(input: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const visit = (node: unknown, depth: number) => {
    if (depth > 4 || node == null) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (PATH_KEYS.has(k) && typeof v === 'string') {
        const p = v.trim()
        // Require a path-ish shape so free-text values don't sneak in.
        if (p.length > 2 && p.length < 400 && /[\\/]/.test(p) && !PATH_NOISE.test(p) && !seen.has(p)) {
          seen.add(p)
          out.push(p)
        }
      } else if (typeof v === 'object') {
        visit(v, depth + 1)
      }
    }
  }

  visit(input, 0)
  return out
}

/** Trailing filename of a path, for grouping and display. */
export function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * Render a tool call as readable lines instead of a raw JSON dump, e.g.
 *   [도구] Edit · Fix null check
 *   file_path: src/App.tsx
 *   new_string:
 *   …
 * Every value is still emitted verbatim, so the tool input stays searchable.
 */
export function summarizeToolUse(name: string, input: unknown): string {
  if (typeof input === 'string') return `[도구] ${name}\n${input}`
  if (!input || typeof input !== 'object') return `[도구] ${name}`
  const rec = input as Record<string, unknown>
  const desc = str(rec.description)
  const lines: string[] = [desc ? `[도구] ${name} · ${desc}` : `[도구] ${name}`]
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'description') continue
    if (typeof v === 'string') {
      lines.push(v.includes('\n') ? `${k}:\n${v}` : `${k}: ${v}`)
    } else if (v == null) {
      continue
    } else if (typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`)
    } else {
      lines.push(`${k}: ${String(v)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Remove harness boilerplate that is addressed to the model, not the reader:
 * the "(file state is current…)" note appended to file-write results and any
 * injected <system-reminder> blocks.
 */
export function stripHarnessNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\s*\(file state is current in your context[^)]*\)/g, '')
    .trim()
}

function textFromToolResult(item: Record<string, unknown>): string {
  const cleaned = stripHarnessNoise(rawToolResultText(item))
  // Never fall through to an empty body (e.g. a result that was only a
  // <system-reminder>) — that would leave the raw line as the preview.
  return cleaned || '[도구 결과]'
}

function rawToolResultText(item: Record<string, unknown>): string {
  const c = item.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const bits: string[] = []
    for (const x of c) {
      if (!x || typeof x !== 'object') continue
      const o = x as { type?: string; text?: string; tool_name?: string }
      if (o.type === 'text' && typeof o.text === 'string') {
        bits.push(o.text)
      } else if (o.type === 'tool_reference') {
        // Result that only points back at a tool — label it instead of dumping
        // the `{"type":"tool_result","tool_use_id":…}` envelope as the body.
        bits.push(o.tool_name ? `[도구 결과] ${o.tool_name}` : '[도구 결과]')
      } else if (typeof o.type === 'string') {
        bits.push(`[${o.type}]`)
      }
    }
    if (bits.length) return bits.join('\n')
  }
  const text = item.text
  if (typeof text === 'string') return text
  // Fall back to the payload itself, never the tool_use_id envelope.
  if (c != null) return typeof c === 'object' ? JSON.stringify(c) : String(c)
  return '[도구 결과]'
}

function textFromThinking(item: Record<string, unknown>): string {
  const th = item.thinking
  if (typeof th === 'string' && th.trim()) return `[thinking] ${th}`
  const text = item.text
  if (typeof text === 'string' && text.trim()) return `[thinking] ${text}`
  return '[thinking]'
}

function toIntOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.trunc(v)
}

/** Parse an ISO-8601 timestamp field to epoch ms; null when missing/invalid. */
export function parseTimestampMs(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/** Pull `{ input, output, cache_read, cache_creation }` tokens from a `usage` object. */
export function extractUsage(usage: unknown): UsageTokens | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const out: UsageTokens = {
    inputTokens: toIntOrNull(u.input_tokens),
    outputTokens: toIntOrNull(u.output_tokens),
    cacheReadTokens: toIntOrNull(u.cache_read_input_tokens),
    cacheCreationTokens: toIntOrNull(u.cache_creation_input_tokens),
    cacheCreation1hTokens: null,
  }
  const cc = u.cache_creation
  if (cc && typeof cc === 'object') {
    out.cacheCreation1hTokens = toIntOrNull((cc as Record<string, unknown>).ephemeral_1h_input_tokens)
  }
  if (
    out.inputTokens == null &&
    out.outputTokens == null &&
    out.cacheReadTokens == null &&
    out.cacheCreationTokens == null
  ) {
    return null
  }
  return out
}

/** Context blocks the IDE/harness attaches to a typed prompt; the prompt is what remains. */
const PROMPT_WRAPPER_BLOCKS =
  /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|browser_instruction)>[\s\S]*?<\/\1>/g

/** User-role text that the harness wrote, not the human. */
const NOT_HUMAN_PROMPT = [
  /^<task-notification>/,
  /^\[Workflow harness/,
  /^\[Request interrupted by user/,
  /^\[SYSTEM NOTIFICATION/,
  /^\[handback-/,
  /^This session is being continued from a previous conversation/,
  /^Caveat: The messages below were generated/,
  /^<local-command-(caveat|stdout|stderr)>/,
  /^<bash-(stdout|stderr)>/,
  /^<fork-boilerplate>/,
]

/**
 * `turnOrigin` (newer Claude Code) says who produced a user turn. These are never the
 * human typing; `sdk` stays (it carries the person's answers to a question prompt).
 */
const NON_HUMAN_TURN_ORIGINS = new Set(['task_notification', 'peer', 'system'])

/**
 * The prompt as the human typed it, or null when the text is harness-generated.
 * Slash commands (`<command-name>`) and `!` shell inputs (`<bash-input>`) are rendered
 * back into the form the user typed.
 */
export function extractPromptText(text: string): string | null {
  const s = text
    .replace(PROMPT_WRAPPER_BLOCKS, '')
    // Pasted text arrives wrapped; the paste itself is what the user typed.
    .replace(/<\/?pasted_content(?:\s[^>]*)?>/g, '')
    .trim()
  if (!s) return null
  const cmd = s.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/)
  if (cmd) {
    const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? ''
    const name = cmd[1].startsWith('/') ? cmd[1] : `/${cmd[1]}`
    return args ? `${name} ${args}` : name
  }
  const bash = s.match(/^<bash-input>([\s\S]*?)<\/bash-input>$/)
  if (bash) return `!${bash[1].trim()}`
  if (NOT_HUMAN_PROMPT.some((re) => re.test(s))) return null
  return s
}

function inferRole(obj: Record<string, unknown>): string {
  const r = obj.role
  if (typeof r === 'string' && r.length > 0) return r
  const msg = obj.message
  if (msg && typeof msg === 'object') {
    const mr = (msg as { role?: string }).role
    if (typeof mr === 'string' && mr.length > 0) return mr
  }
  return 'unknown'
}

/**
 * Claude Code feeds tool output back through a `user` message (API convention),
 * but it is tool output — not something the human typed. Re-attribute those
 * lines to a `tool` role so the UI never renders them as the user's own words
 * and the user/assistant role filter returns real prompts only.
 */
export function effectiveRole(role: string, contentKinds: string[]): string {
  if (
    role === 'user' &&
    contentKinds.length > 0 &&
    contentKinds.every((k) => k === 'tool_result')
  ) {
    return 'tool'
  }
  return role
}

export function classifyMessage(
  role: string,
  contentKinds: string[],
  body: string,
): MessageClass {
  const dialogRoles = new Set(['user', 'assistant', 'tool'])
  if (dialogRoles.has(role) && (contentKinds.includes('text') || contentKinds.includes('string'))) {
    return 'dialog'
  }
  if (dialogRoles.has(role) && contentKinds.some((k) => k === 'tool_use' || k === 'tool_result')) {
    return 'dialog'
  }
  const onlyMeta =
    contentKinds.length > 0 &&
    contentKinds.every((k) => META_KINDS.has(k) || AUX_META_KINDS.has(k)) &&
    !contentKinds.includes('text') &&
    !contentKinds.includes('string') &&
    !contentKinds.includes('last-prompt') &&
    !contentKinds.includes('tool_use') &&
    !contentKinds.includes('tool_result')
  if (onlyMeta) return 'meta'
  if (
    role === 'unknown' &&
    contentKinds.length > 0 &&
    contentKinds.every((k) => META_KINDS.has(k) || k.startsWith('object'))
  ) {
    return 'meta'
  }
  if (role === 'unknown' && /^\[(권한|에이전트|제목|세션|tool_use)/.test(body.trim())) {
    return 'meta'
  }
  if (dialogRoles.has(role)) return 'dialog'
  if (role === 'system') return 'meta'
  return 'other'
}

export function extractTextFromContent(content: unknown): {
  text: string
  kinds: string[]
  filePaths: string[]
} {
  const kinds: string[] = []
  const filePaths: string[] = []
  if (content == null) return { text: '', kinds, filePaths }

  if (typeof content === 'string') {
    kinds.push('string')
    return { text: content, kinds, filePaths }
  }

  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const t = rec.type
      const ts = typeof t === 'string' ? t : ''
      if (ts) kinds.push(ts)
      if (ts === 'text' && typeof rec.text === 'string') {
        parts.push(rec.text)
      } else if (ts === 'last-prompt') {
        const lp = textFromLastPromptPart(rec)
        parts.push(lp ?? '[last-prompt]')
      } else if (META_KINDS.has(ts)) {
        parts.push(summarizeMetaPart(rec, ts))
      } else if (ts === 'tool_use') {
        const name = typeof rec.name === 'string' ? rec.name : 'tool'
        for (const fp of extractFilePaths(rec.input)) filePaths.push(fp)
        parts.push(summarizeToolUse(name, rec.input))
      } else if (ts === 'tool_result') {
        parts.push(textFromToolResult(rec))
      } else if (ts === 'thinking') {
        parts.push(textFromThinking(rec))
      } else if (ts && ts !== 'text') {
        parts.push(summarizeMetaPart(rec, ts))
      }
    }
    return {
      text: parts.join('\n'),
      kinds: [...new Set(kinds)],
      filePaths: [...new Set(filePaths)],
    }
  }

  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const c = content as Record<string, unknown>
    const lp = textFromLastPromptPart(c)
    if (lp) {
      kinds.push('last-prompt')
      return { text: lp, kinds, filePaths }
    }
    const ty = typeof c.type === 'string' ? c.type : ''
    if (ty && META_KINDS.has(ty)) {
      kinds.push(ty)
      return { text: summarizeMetaPart(c, ty), kinds, filePaths }
    }
    if (ty === 'tool_result') {
      kinds.push('tool_result')
      return { text: textFromToolResult(c), kinds, filePaths }
    }
    if (ty === 'thinking') {
      kinds.push('thinking')
      return { text: textFromThinking(c), kinds, filePaths }
    }
  }

  if (typeof content === 'object' && 'text' in (content as object)) {
    const tx = (content as { text?: unknown }).text
    if (typeof tx === 'string') {
      kinds.push('object.text')
      return { text: tx, kinds, filePaths }
    }
  }

  kinds.push('unknown')
  return { text: JSON.stringify(content), kinds, filePaths }
}

export function parseJsonlLine(line: string): ParsedLine | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return {
      role: 'unknown',
      text: '',
      contentKinds: ['invalid_json'],
      rawPreview: truncate(trimmed, 200),
      messageClass: 'other',
      filePaths: [],
      cwd: null,
      gitBranch: null,
      tsMs: null,
      model: null,
      usage: null,
      isSidechain: false,
      uuid: null,
      apiMessageId: null,
      requestId: null,
      isPrompt: false,
      promptText: null,
    }
  }

  const rawRole = inferRole(obj)
  const message = obj.message
  let text = ''
  let contentKinds: string[] = []
  let filePaths: string[] = []
  let model: string | null = null
  let usage: UsageTokens | null = null
  let apiMessageId: string | null = null
  const topType = str(obj.type)
  const conversational = !topType || CONVERSATION_TYPES.has(topType)

  if (message && typeof message === 'object') {
    const m = message as { content?: unknown; model?: unknown; usage?: unknown; id?: unknown }
    const extracted = extractTextFromContent(m.content)
    text = extracted.text
    contentKinds = extracted.kinds
    filePaths = extracted.filePaths
    if (typeof m.model === 'string' && m.model.trim()) model = m.model
    // Only real responses carry billable usage; a bookkeeping copy must not count twice.
    if (conversational) {
      usage = extractUsage(m.usage)
      if (usage && typeof m.id === 'string' && m.id) apiMessageId = m.id
    }
  } else if (typeof obj.content !== 'undefined') {
    const extracted = extractTextFromContent(obj.content)
    text = extracted.text
    contentKinds = extracted.kinds
    filePaths = extracted.filePaths
  }

  // A line with no extractable content is bookkeeping, not conversation. Give it
  // a short label (never the raw JSON) and file it under `meta` so the default
  // filters hide it from search results and the transcript.
  let isBookkeeping = false
  if (!text.trim() && topType && topType !== 'user' && topType !== 'assistant') {
    text = operationalLabel(obj, topType)
    if (!contentKinds.length) contentKinds = [topType]
    isBookkeeping = true
  } else if (!text.trim() && OPERATIONAL_TYPES.has(topType)) {
    text = operationalLabel(obj, topType)
    isBookkeeping = true
  } else if (!conversational) {
    // Typed bookkeeping that happens to carry content: keep it readable under its label.
    text = `${operationalLabel(obj, topType)}\n${truncate(text, MAX_BOOKKEEPING_BODY)}`
    isBookkeeping = true
  }
  // A copy of a request (api-request-blob…) repeats tool calls that already appear on
  // their real lines; recording its paths would list the same edit twice in Files.
  if (!conversational) filePaths = []
  // Harness-injected user turns (skill bodies, caveats) are flagged `isMeta` by Claude Code.
  if (obj.isMeta === true) isBookkeeping = true

  const rawPreview =
    text.length > 0 ? truncate(text, 160) : truncate(trimmed, 200)

  const role = conversational ? effectiveRole(rawRole, contentKinds) : 'unknown'
  const messageClass = isBookkeeping
    ? 'meta'
    : classifyMessage(role, contentKinds, text || rawPreview)
  const tsMs = parseTimestampMs(obj.timestamp)
  const isSidechain = obj.isSidechain === true
  const cwd = str(obj.cwd) || null
  const gitBranch = str(obj.gitBranch) || null
  const promptText =
    role === 'user' &&
    !isBookkeeping &&
    !isSidechain &&
    !NON_HUMAN_TURN_ORIGINS.has(str(obj.turnOrigin)) &&
    (contentKinds.includes('text') || contentKinds.includes('string'))
      ? extractPromptText(text)
      : null

  return {
    role,
    text,
    contentKinds,
    rawPreview,
    messageClass,
    tsMs,
    model,
    usage,
    isSidechain,
    filePaths,
    cwd,
    gitBranch,
    uuid: str(obj.uuid) || null,
    apiMessageId,
    requestId: apiMessageId ? str(obj.requestId) || null : null,
    isPrompt: promptText != null,
    promptText,
    sessionTitle: conversational ? null : sessionTitleOf(obj),
  }
}

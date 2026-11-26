import type { ModelPrice } from '../shared/pricing.js'
import {
  BACKUP_KEEP_CHOICES,
  GLOBAL_SHORTCUT_CHOICES,
  type ExportFileFormat,
  type ExportOptions,
  type PromptQuery,
  type SearchFilters,
  type SessionExportFormat,
  type SessionExportOptions,
  type SessionListQuery,
  type Settings,
} from '../shared/ipc.js'

const MAX_SEARCH_LIMIT = 200
const MAX_EXPORT_MESSAGE_IDS = 5000
const DEFAULT_SEARCH_LIMIT = 80

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const x = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN
  if (!Number.isFinite(x)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(x)))
}

function positiveIntOrNull(n: unknown): number | null {
  const x = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN
  if (!Number.isFinite(x)) return null
  const t = Math.trunc(x)
  return t > 0 ? t : null
}

/** IPC에서 넘어온 값을 `SearchFilters`로 정규화(상한·타입). */
export function sanitizeSearchFilters(raw: unknown): SearchFilters {
  const o = isPlainObject(raw) ? raw : {}
  const query = typeof o.query === 'string' ? o.query : ''
  const projectId = positiveIntOrNull(o.projectId)
  const roleRaw = o.role
  const role =
    roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === '' ? roleRaw : ''
  const limit = clampInt(o.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT)
  const excludeMeta = o.excludeMeta === false ? false : true
  const excludeSubagents = o.excludeSubagents === true
  const excludeTools = o.excludeTools === true
  const tagId = positiveIntOrNull(o.tagId)
  const scopeRaw = o.scope
  const scope =
    scopeRaw === 'messages' || scopeRaw === 'plans' || scopeRaw === 'all' ? scopeRaw : undefined
  const matchModeRaw = o.matchMode
  const matchMode =
    matchModeRaw === 'any' || matchModeRaw === 'all' || matchModeRaw === 'phrase'
      ? matchModeRaw
      : undefined
  const sortRaw = o.sort
  const sort =
    sortRaw === 'relevance' || sortRaw === 'newest' || sortRaw === 'oldest' ? sortRaw : undefined
  const sinceMs = positiveIntOrNull(o.sinceMs)
  const untilMs = positiveIntOrNull(o.untilMs)

  const out: SearchFilters = {
    query,
    limit,
    excludeMeta,
    excludeSubagents,
    excludeTools,
  }
  if (projectId != null) out.projectId = projectId
  if (tagId != null) out.tagId = tagId
  if (role) out.role = role as 'user' | 'assistant'
  if (scope) out.scope = scope
  if (matchMode) out.matchMode = matchMode
  if (sort) out.sort = sort
  if (sinceMs != null) out.sinceMs = sinceMs
  if (untilMs != null) out.untilMs = untilMs
  const offset = clampInt(o.offset, 0, 100_000, 0)
  if (offset > 0) out.offset = offset
  const planOffset = clampInt(o.planOffset, 0, 100_000, 0)
  if (planOffset > 0) out.planOffset = planOffset
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
  const projectQuery = text(o.projectQuery, 300)
  if (projectQuery) out.projectQuery = projectQuery
  const branch = text(o.branch, 300)
  if (branch) out.branch = branch
  if (o.archived === 'archived' || o.archived === 'live') out.archived = o.archived
  const sessionId = positiveIntOrNull(o.sessionId)
  if (sessionId != null) out.sessionId = sessionId
  const regex = text(o.regex, 1000)
  if (regex) {
    out.regex = regex
    if (typeof o.regexFlags === 'string') out.regexFlags = o.regexFlags.replace(/[^imsu]/g, '').slice(0, 4)
  }
  return out
}

export function sanitizeSessionListQuery(raw: unknown): SessionListQuery {
  const o = isPlainObject(raw) ? raw : {}
  const out: SessionListQuery = {
    query: typeof o.query === 'string' ? o.query.slice(0, 300) : '',
    archived: o.archived === 'archived' || o.archived === 'live' ? o.archived : 'all',
    sort: o.sort === 'oldest' || o.sort === 'longest' ? o.sort : 'recent',
    offset: clampInt(o.offset, 0, 1_000_000, 0),
    limit: clampInt(o.limit, 1, 200, 50),
  }
  const projectId = positiveIntOrNull(o.projectId)
  if (projectId != null) out.projectId = projectId
  return out
}

export function sanitizeTranscriptWindow(raw: unknown): { from?: number; aroundLine?: number } {
  const o = isPlainObject(raw) ? raw : {}
  const out: { from?: number; aroundLine?: number } = {}
  if (o.from != null) out.from = clampInt(o.from, 0, 10_000_000, 0)
  if (typeof o.aroundLine === 'number' && o.aroundLine >= 0) out.aroundLine = clampInt(o.aroundLine, 0, 10_000_000, 0)
  return out
}

export function sanitizeSessionExportFormat(raw: unknown): SessionExportFormat {
  return raw === 'html' ? 'html' : 'md'
}

export function sanitizeSessionExportOptions(raw: unknown): SessionExportOptions {
  const o = isPlainObject(raw) ? raw : {}
  return { includeTools: o.includeTools === true, includeMeta: o.includeMeta === true }
}

export function sanitizeLocale(raw: unknown): 'ko' | 'en' {
  return raw === 'en' ? 'en' : 'ko'
}

export function sanitizeExportMessageIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const x of raw) {
    const id = positiveIntOrNull(x)
    if (id != null) out.push(id)
    if (out.length >= MAX_EXPORT_MESSAGE_IDS) break
  }
  return out
}

export function sanitizeExportOptions(raw: unknown): ExportOptions {
  if (!isPlainObject(raw)) return {}
  return {
    excludeMeta: raw.excludeMeta === false ? false : undefined,
    excludeSubagents: raw.excludeSubagents === true ? true : undefined,
  }
}

export function sanitizeSessionId(raw: unknown): number | null {
  return positiveIntOrNull(raw)
}

export function sanitizePlanId(raw: unknown): number | null {
  return positiveIntOrNull(raw)
}

export function sanitizeMessageId(raw: unknown): number | null {
  return positiveIntOrNull(raw)
}

/** Stable message keys are uuids or `file#line`; bound the length, nothing else is assumed. */
export function sanitizeMsgKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const k = raw.trim()
  return k && k.length <= 2000 ? k : null
}

export function sanitizeTagName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .slice(0, 200)
}

/** Tag colors are only ever rendered as CSS; accept `#rgb`/`#rrggbb` or nothing. */
export function sanitizeTagColor(raw: unknown): string | null {
  return typeof raw === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(raw) ? raw : null
}

export function sanitizePromptQuery(raw: unknown): PromptQuery {
  const o = isPlainObject(raw) ? raw : {}
  const out: PromptQuery = {
    query: typeof o.query === 'string' ? o.query.slice(0, 500) : '',
    sort: o.sort === 'frequent' ? 'frequent' : 'recent',
    limit: clampInt(o.limit, 1, 500, 200),
  }
  const projectId = positiveIntOrNull(o.projectId)
  if (projectId != null) out.projectId = projectId
  return out
}

export function sanitizeSettingsPatch(raw: unknown): Partial<Settings> {
  const o = isPlainObject(raw) ? raw : {}
  const out: Partial<Settings> = {}
  if (o.archiveMode === 'keep' || o.archiveMode === 'mirror') out.archiveMode = o.archiveMode
  if (typeof o.autoUpdate === 'boolean') out.autoUpdate = o.autoUpdate
  if ((BACKUP_KEEP_CHOICES as readonly unknown[]).includes(o.backupKeep)) out.backupKeep = o.backupKeep as number
  if (typeof o.maskSecrets === 'boolean') out.maskSecrets = o.maskSecrets
  if (typeof o.archiveNotify === 'boolean') out.archiveNotify = o.archiveNotify
  if ((GLOBAL_SHORTCUT_CHOICES as readonly unknown[]).includes(o.globalShortcut)) out.globalShortcut = o.globalShortcut as string
  return out
}

/** Clipboard text is truncated rather than rejected so a huge copy still does something. */
export function sanitizeClipboardText(raw: unknown): string {
  const s = String(raw ?? '')
  const max = 5_000_000
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s
}

export function sanitizeExportFormat(raw: unknown): 'md' | 'csv' {
  return raw === 'csv' ? 'csv' : 'md'
}

/** Formats a saved file may have: the message exports plus a session's HTML page. */
export function sanitizeExportFileFormat(raw: unknown): ExportFileFormat {
  return raw === 'csv' || raw === 'html' ? raw : 'md'
}

export function sanitizeFileQuery(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 300)
}

/** A path is only ever used as an exact lookup key, so just bound its length. */
export function sanitizeFilePath(raw: unknown): string {
  return String(raw ?? '').slice(0, 1000)
}

export function sanitizeTemplateName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .slice(0, 200)
}

export function sanitizeTemplateBody(raw: unknown): string {
  // Cap at 200k chars to keep a single template row bounded.
  return String(raw ?? '').slice(0, 200_000)
}

export function sanitizeTemplateId(raw: unknown): number | null {
  return positiveIntOrNull(raw)
}

export function sanitizeTagIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const x of raw) {
    const id = positiveIntOrNull(x)
    if (id != null) out.push(id)
    if (out.length >= 500) break
  }
  return out
}

/** Prices arrive from the renderer as free-form JSON; coerce to finite, non-negative rates. */
export function sanitizePrices(raw: unknown): ModelPrice[] {
  if (!Array.isArray(raw)) return []
  const rate = (v: unknown): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return 0
    // Nothing plausible costs more than $10k/MTok; clamp rather than reject so a
    // fat-fingered edit degrades to a bounded number instead of dropping the row.
    return Math.min(n, 10_000)
  }
  const out: ModelPrice[] = []
  const seen = new Set<string>()
  for (const x of raw.slice(0, 200)) {
    if (!x || typeof x !== 'object') continue
    const r = x as Record<string, unknown>
    const model = String(r.model ?? '').trim().slice(0, 120)
    if (!model || seen.has(model)) continue
    seen.add(model)
    out.push({
      model,
      inputPerMTok: rate(r.inputPerMTok),
      outputPerMTok: rate(r.outputPerMTok),
      cacheReadPerMTok: rate(r.cacheReadPerMTok),
      cacheWritePerMTok: rate(r.cacheWritePerMTok),
      cacheWrite1hPerMTok: rate(r.cacheWrite1hPerMTok ?? Number(r.inputPerMTok) * 2),
    })
  }
  return out
}

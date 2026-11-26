export const IPC = {
  projectsList: 'vault:projectsList',
  search: 'vault:search',
  plansList: 'vault:plansList',
  planBody: 'vault:planBody',
  reindex: 'vault:reindex',
  copyText: 'vault:copyText',
  messageBody: 'vault:messageBody',
  favoritesList: 'vault:favoritesList',
  favoriteAdd: 'vault:favoriteAdd',
  favoriteRemove: 'vault:favoriteRemove',
  tagsList: 'vault:tagsList',
  tagCreate: 'vault:tagCreate',
  tagRename: 'vault:tagRename',
  tagDelete: 'vault:tagDelete',
  messageTagsSet: 'vault:messageTagsSet',
  stats: 'vault:stats',
  exportMessages: 'vault:exportMessages',
  exportSave: 'vault:exportSave',
  sessionTranscript: 'vault:sessionTranscript',
  sessionInfo: 'vault:sessionInfo',
  recentSessions: 'vault:recentSessions',
  promptsList: 'vault:promptsList',
  templatesList: 'vault:templatesList',
  templateCreate: 'vault:templateCreate',
  templateUpdate: 'vault:templateUpdate',
  templateDelete: 'vault:templateDelete',
  filesList: 'vault:filesList',
  pricesList: 'vault:pricesList',
  pricesSave: 'vault:pricesSave',
  pricesReset: 'vault:pricesReset',
  fileTimeline: 'vault:fileTimeline',
  settingsGet: 'vault:settingsGet',
  settingsSet: 'vault:settingsSet',
  archivePurge: 'vault:archivePurge',
  backupsList: 'vault:backupsList',
  backupCreate: 'vault:backupCreate',
  backupRestore: 'vault:backupRestore',
  backupsReveal: 'vault:backupsReveal',
  updateCheck: 'vault:updateCheck',
  updateInstall: 'vault:updateInstall',
  updateStatus: 'vault:updateStatus',
  mcpCommand: 'vault:mcpCommand',
  onIndexUpdated: 'vault:onIndexUpdated',
  onIndexProgress: 'vault:onIndexProgress',
  onUpdateStatus: 'vault:onUpdateStatus',
  sessionsList: 'vault:sessionsList',
  sessionDetail: 'vault:sessionDetail',
  transcriptPage: 'vault:transcriptPage',
  exportSession: 'vault:exportSession',
  handoffPrompt: 'vault:handoffPrompt',
  onFocusSearch: 'vault:onFocusSearch',
  onArchiveNews: 'vault:onArchiveNews',
} as const

/** How Claude Code starts Trove's local MCP server (ADR-0011). */
export type McpCommand = {
  command: string
  args: string[]
  env: Record<string, string>
  /** Ready-to-paste `claude mcp add trove …` line. */
  claudeAddLine: string
}

export type FileRow = {
  path: string
  basename: string
  /** How many messages touched it, and across how many sessions. */
  touches: number
  sessions: number
  lastTouched: number | null
  projectName: string
}

export type FileTouchRow = {
  messageId: number
  sessionId: number
  sessionFile: string
  projectName: string
  role: string
  tsMs: number | null
  gitBranch: string | null
  lineIndex: number
  preview: string
}

export type UpdateStatus = {
  /** `unsupported` = dev or unsigned build with no update feed; `disabled` = turned off in settings. */
  state: 'idle' | 'unsupported' | 'disabled' | 'checking' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
}

export type MessageClass = 'dialog' | 'meta' | 'other'

export type ExportOptions = {
  excludeMeta?: boolean
  excludeSubagents?: boolean
}

export type ProjectRow = {
  id: number
  slug: string
  displayName: string
  path: string
  sessionCount: number
  /** Sessions kept after their source file was deleted. */
  archivedCount: number
  lastModified: number | null
  /** Source tool: 'claude' | 'codex' | … */
  tool: string
  /** Set when the project's source directory no longer exists. */
  archived: boolean
}

export type SessionMessageRow = {
  messageId: number
  msgKey: string
  lineIndex: number
  role: string
  body: string
  messageClass: MessageClass
  /** Parsed `content_kinds` (e.g. ['tool_use']) so the UI can tell tool activity from prose. */
  contentKinds: string[]
}

export type SessionInfo = {
  sessionId: number
  filePath: string
  /** Epoch ms when the source file was found missing; null while it exists. */
  archivedAt: number | null
}

export type SearchHit = {
  messageId: number
  /** Stable identity used by favorites and tags (survives re-indexing). */
  msgKey: string
  sessionId: number
  projectId: number
  projectSlug: string
  projectName: string
  sessionFile: string
  lineIndex: number
  role: string
  /** Body, clamped for transport; fetch the full text with `messageBody` when `bodyTruncated`. */
  body: string
  bodyTruncated: boolean
  snippet: string
  rank: number
  messageClass: MessageClass
  /** Message timestamp (epoch ms) when available, else null. */
  tsMs: number | null
  tagIds: number[]
  isFavorite: boolean
  /** The session's source file is gone; this hit lives only in the vault. */
  archived: boolean
}

export type SearchScope = 'messages' | 'plans' | 'all'

export type PlanHit = {
  hitType: 'plan'
  planId: number
  filePath: string
  title: string
  snippet: string
  rank: number
  mtime: number
  /** The plan file is gone; this copy lives only in the vault. */
  archived: boolean
}

export type MessageHit = SearchHit & { hitType: 'message' }

export type UnifiedSearchHit = MessageHit | PlanHit

export type PlanListRow = {
  id: number
  filePath: string
  title: string
  mtime: number
  archived: boolean
}

export type MatchMode = 'any' | 'all' | 'phrase'
export type SortMode = 'relevance' | 'newest' | 'oldest'

export type SearchFilters = {
  query: string
  projectId?: number
  role?: 'user' | 'assistant' | ''
  limit?: number
  /** 기본 true: 메타(권한·제목 등) 줄 검색 결과에서 제외 */
  excludeMeta?: boolean
  /** true면 subagents 경로의 로그 제외 */
  excludeSubagents?: boolean
  /** true면 도구 호출·도구 결과 줄 제외 (UI 기본값 true) */
  excludeTools?: boolean
  /** 이 태그가 붙은 메시지만. 검색어가 비어 있으면 태그된 메시지 전체를 최신순으로. */
  tagId?: number
  /** 검색 대상: 대화(세션) / 플랜 Markdown / 둘 다. 기본 `messages`. */
  scope?: SearchScope
  /** 토큰 결합 방식: 아무거나(OR) / 모두(AND) / 구문(정확). 기본 `any`. */
  matchMode?: MatchMode
  /** 정렬: 관련도(FTS rank) / 최신 / 오래된. 기본 `relevance`. */
  sort?: SortMode
  /** 이 epoch(ms) 이후 메시지만 (메시지 timestamp 기준). */
  sinceMs?: number
  /** 이 epoch(ms) 이전 메시지만. */
  untilMs?: number
  /** Messages already shown: the next page starts here (messages and plans page separately). */
  offset?: number
  planOffset?: number
  /** `project:` operator — substring of the project's display name, case-insensitive. */
  projectQuery?: string
  /** `branch:` operator — substring of the git branch recorded on the line. */
  branch?: string
  /** `is:archived` / `is:live`. */
  archived?: 'archived' | 'live'
  /** Only this session (search inside one transcript). */
  sessionId?: number
  /** `/…/` query: a JavaScript regular expression over message bodies, instead of `query`. */
  regex?: string
  regexFlags?: string
}

export type RecentSessionRow = {
  sessionId: number
  projectName: string
  sessionFile: string
  mtime: number
  preview: string | null
  archived: boolean
}

export type SessionSort = 'recent' | 'oldest' | 'longest'

export type SessionListQuery = {
  projectId?: number
  /** Matches title, first prompt, working directory and branch. */
  query?: string
  archived?: 'all' | 'archived' | 'live'
  sort?: SessionSort
  offset?: number
  limit?: number
}

/** A top-level session: subagent transcripts are counted on their parent, not listed. */
export type SessionListRow = {
  sessionId: number
  projectId: number
  projectName: string
  tool: string
  sessionFile: string
  title: string | null
  /** First prompt I typed in it (or first dialog line). */
  preview: string | null
  cwd: string | null
  gitBranch: string | null
  firstTsMs: number | null
  lastTsMs: number | null
  mtime: number
  messageCount: number
  subagentCount: number
  archived: boolean
  archivedAt: number | null
}

export type SessionListResult = { rows: SessionListRow[]; total: number }

export type SubagentRow = {
  sessionId: number
  sessionFile: string
  title: string | null
  preview: string | null
  messageCount: number
  firstTsMs: number | null
  lastTsMs: number | null
}

export type SessionDetail = {
  sessionId: number
  projectId: number
  projectName: string
  tool: string
  sessionFile: string
  filePath: string
  title: string | null
  cwd: string | null
  gitBranch: string | null
  firstTsMs: number | null
  lastTsMs: number | null
  messageCount: number
  promptCount: number
  archivedAt: number | null
  /** Shell line that reopens it, or null when the tool's session id is unknown. */
  resumeCommand: string | null
  forkCommand: string | null
  /** Set for a subagent transcript: the session that started it. */
  parentSessionId: number | null
  subagents: SubagentRow[]
  /** API responses in this session, counted once each. */
  tokensByModel: ModelTokenRow[]
  filesTouched: number
}

export type TranscriptPage = {
  rows: SessionMessageRow[]
  /** Line-ordered position of `rows[0]` among all of the session's rows. */
  from: number
  total: number
}

export type SessionExportFormat = 'md' | 'html'

export type SessionExportOptions = {
  includeTools?: boolean
  includeMeta?: boolean
}

/** Text that leaves the app, and how many secrets were masked on the way. */
export type MaskedText = { text: string; masked: number }

/** Sessions Claude Code deleted since the last notice, now kept only in the vault. */
export type ArchiveNews = { newlyArchived: number; totalArchived: number }

export type PromptSort = 'recent' | 'frequent'

export type PromptQuery = {
  query: string
  projectId?: number
  sort?: PromptSort
  limit?: number
}

/** A distinct prompt the human typed, with how often and when it was used. */
export type PromptRow = {
  text: string
  uses: number
  lastTsMs: number | null
  firstTsMs: number | null
  /** The most recent occurrence — what "open session", favorite and tag act on. */
  messageId: number
  msgKey: string
  sessionId: number
  sessionFile: string
  lineIndex: number
  projectName: string
  archived: boolean
  isFavorite: boolean
}

export type FavoriteRow = {
  id: number
  msgKey: string
  body: string
  role: string
  projectLabel: string
  sessionFile: string
  createdAt: number
  /** Live location of the starred line; null when it is no longer in the index. */
  messageId: number | null
  sessionId: number | null
  lineIndex: number | null
  archived: boolean
  tagIds: number[]
}

export type TagRow = {
  id: number
  name: string
  color: string | null
  /** Messages carrying the tag. */
  count: number
}

export type TokenTotals = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

/** API responses and full token usage for one model — the input to cost estimation. */
export type ModelTokenRow = {
  model: string
  /** API responses (deduplicated), not transcript lines. */
  messages: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** Subset of `cacheCreation` written with the 1-hour TTL. */
  cacheCreation1h: number
}

export type StatsPayload = {
  totalProjects: number
  totalSessions: number
  archivedSessions: number
  /** Plans kept after their file was deleted. */
  archivedPlans: number
  totalMessages: number
  totalPrompts: number
  messagesByRole: { role: string; count: number }[]
  /** Words in my own prompts, counted as the number of prompts containing them. */
  topTokens: { token: string; count: number }[]
  activityByDay: { day: string; count: number }[]
  /** Token usage counted once per API response (schema v9+). */
  tokenTotals: TokenTotals
  /** Per-model breakdown of API responses and their token usage. */
  tokensByModel: ModelTokenRow[]
  /** True when `activityByDay` counts prompts by timestamp rather than session mtime. */
  activityFromTimestamps: boolean
  /** Local days (`YYYY-MM-DD`, oldest first) the app was opened in the last ~two months. */
  appOpenDays: string[]
  /** Prompts per local day over the 53-week grid ending this week; days with none left out. */
  activityYear: { day: string; count: number }[]
  /** Prompts by local weekday (0 = Sunday) and hour, all time; empty cells left out. */
  activityByHour: { weekday: number; hour: number; count: number }[]
  /** Usage per project (top 15 by tokens), each API response counted once. */
  tokensByProject: ProjectUsageRow[]
  /** Most-called tools (top 20); `errors` is a heuristic, see `ToolUsageRow`. */
  toolUsage: ToolUsageRow[]
  /** The last 10 five-hour usage blocks, oldest first. */
  usageBlocks: UsageBlock[]
}

export type ProjectUsageRow = {
  projectId: number
  projectName: string
  sessions: number
  /** API responses (deduplicated); a response held by sessions of two projects counts in the first. */
  responses: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  cacheCreation1h: number
  byModel: ModelTokenRow[]
}

export type ToolUsageRow = {
  tool: string
  /** Calls, counted once per transcript line. */
  calls: number
  /**
   * Results that look like errors (start with `<tool_use_error>`, `Error:`, `error:` or
   * `Exit code <n>`), matched to calls by order. An approximation: the index does not keep `is_error`.
   */
  errors: number
}

/** A Claude subscription window: opens at the hour of its first response, lasts five hours. */
export type UsageBlock = {
  startMs: number
  endMs: number
  responses: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export type ReindexResult = {
  projects: number
  sessions: number
  planFiles: number
}

export type TemplateRow = {
  id: number
  name: string
  body: string
  createdAt: number
  updatedAt: number
}

export type IndexProgress = {
  phase: 'projects' | 'plans' | 'done'
  current: number
  total: number
  label?: string
}

export type ArchiveMode = 'keep' | 'mirror'

export type Settings = {
  /** What happens to indexed sessions when Claude Code deletes their files. */
  archiveMode: ArchiveMode
  /** Check GitHub Releases for updates (the app's only network request). */
  autoUpdate: boolean
  /** How many DB snapshots to keep (0 turns automatic backups off). */
  backupKeep: number
  /** Mask tokens, keys and passwords in copied and exported text. */
  maskSecrets: boolean
  /** Accelerator that shows Trove from anywhere ('' = off). One of `GLOBAL_SHORTCUT_CHOICES`. */
  globalShortcut: string
  /** System notification when Trove keeps sessions Claude Code deleted. */
  archiveNotify: boolean
}

export const GLOBAL_SHORTCUT_CHOICES = ['', 'CommandOrControl+Shift+Space', 'Alt+Shift+Space', 'CommandOrControl+Alt+Y'] as const

export type SettingsInfo = Settings & {
  dbPath: string
  dbSizeBytes: number
  claudeHome: string
  /** Plans kept after their file was deleted (sessions come with the project list). */
  archivedPlans: number
}

export type ExportSaveResult = { saved: boolean; path?: string; error?: string }

export type ExportFileFormat = 'md' | 'csv' | 'html'

/** Allowed values for `Settings.backupKeep`; 0 turns automatic backups off. */
export const BACKUP_KEEP_CHOICES = [0, 1, 3, 7] as const
export const DEFAULT_BACKUP_KEEP = 3

/** Why a snapshot was taken: on schedule, by hand, or right before a destructive step. */
export type BackupReason = 'daily' | 'manual' | 'pre-migration' | 'pre-purge' | 'pre-restore'

export type BackupFile = {
  /** File name in the backup folder; also the id the renderer passes back. */
  name: string
  createdAt: number
  reason: BackupReason
  sizeBytes: number
}

export type BackupInfo = {
  dir: string
  keep: number
  items: BackupFile[]
  totalBytes: number
}

export type BackupResult =
  | { ok: true; file: BackupFile }
  | { ok: false; error: 'disk' | 'failed'; message?: string }

/** A successful restore relaunches the app, so only failures come back. */
export type RestoreResult = { ok: false; error: 'invalid' | 'newer-schema' | 'missing' | 'failed'; message?: string }

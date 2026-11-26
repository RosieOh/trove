/// <reference types="vite/client" />

import type {
  BackupInfo,
  BackupResult,
  ExportOptions,
  ExportSaveResult,
  FavoriteRow,
  FileRow,
  FileTouchRow,
  IndexProgress,
  McpCommand,
  PlanListRow,
  ProjectRow,
  PromptQuery,
  PromptRow,
  RecentSessionRow,
  ReindexResult,
  RestoreResult,
  SearchFilters,
  SessionInfo,
  SessionMessageRow,
  Settings,
  SettingsInfo,
  StatsPayload,
  TagRow,
  TemplateRow,
  UpdateStatus,
  UnifiedSearchHit,
  ArchiveNews,
  ExportFileFormat,
  MaskedText,
  SessionDetail,
  SessionExportFormat,
  SessionExportOptions,
  SessionListQuery,
  SessionListResult,
  TranscriptPage,
} from '../shared/ipc'
import type { ModelPrice } from '../shared/pricing'

export type VaultApi = {
  projectsList: () => Promise<ProjectRow[]>
  /** Resolves to `null` when a newer search superseded this one before it ran. */
  search: (filters: SearchFilters) => Promise<UnifiedSearchHit[] | null>
  plansList: () => Promise<PlanListRow[]>
  planBody: (planId: number) => Promise<string>
  reindex: (reparse?: boolean) => Promise<ReindexResult>
  /** Resolves to how many secrets were masked on the way to the clipboard. */
  copyText: (text: string) => Promise<number>
  messageBody: (messageId: number) => Promise<string>
  favoritesList: () => Promise<FavoriteRow[]>
  favoriteAdd: (messageId: number) => Promise<void>
  favoriteRemove: (msgKey: string) => Promise<void>
  tagsList: () => Promise<TagRow[]>
  tagCreate: (name: string, color?: string | null) => Promise<number>
  tagRename: (id: number, name: string) => Promise<boolean>
  tagDelete: (id: number) => Promise<void>
  messageTagsSet: (msgKey: string, tagIds: number[]) => Promise<void>
  stats: () => Promise<StatsPayload>
  exportMessages: (messageIds: number[], format: 'md' | 'csv', opts?: ExportOptions) => Promise<string>
  exportSave: (text: string, format: ExportFileFormat) => Promise<ExportSaveResult>
  sessionTranscript: (sessionId: number) => Promise<SessionMessageRow[]>
  sessionInfo: (sessionId: number) => Promise<SessionInfo | null>
  recentSessions: (projectId?: number | null) => Promise<RecentSessionRow[]>
  promptsList: (q: PromptQuery) => Promise<PromptRow[]>
  pricesList: () => Promise<ModelPrice[]>
  pricesSave: (prices: ModelPrice[]) => Promise<ModelPrice[]>
  pricesReset: () => Promise<ModelPrice[]>
  templatesList: () => Promise<TemplateRow[]>
  templateCreate: (name: string, body: string) => Promise<number>
  templateUpdate: (id: number, name: string, body: string) => Promise<void>
  templateDelete: (id: number) => Promise<void>
  filesList: (query: string) => Promise<FileRow[]>
  fileTimeline: (path: string) => Promise<FileTouchRow[]>
  settingsGet: () => Promise<SettingsInfo>
  settingsSet: (patch: Partial<Settings>) => Promise<Settings>
  archivePurge: () => Promise<number>
  backupsList: () => Promise<BackupInfo>
  /** Snapshot now (on the index worker, behind any running scan). */
  backupCreate: () => Promise<BackupResult>
  /** Swaps the backup in and relaunches the app; resolves only when it could not. */
  backupRestore: (name: string) => Promise<RestoreResult>
  backupsReveal: () => Promise<void>
  updateStatus: () => Promise<UpdateStatus>
  updateCheck: () => Promise<UpdateStatus>
  updateInstall: () => Promise<void>
  /** How to register Trove's MCP server with Claude Code. */
  mcpCommand: () => Promise<McpCommand>
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void
  onIndexUpdated: (cb: () => void) => () => void
  onIndexProgress: (cb: (p: IndexProgress) => void) => () => void
  sessionsList: (q: SessionListQuery) => Promise<SessionListResult>
  sessionDetail: (sessionId: number) => Promise<SessionDetail | null>
  /** A window of a transcript: from a row position, or around a line (a search hit). */
  transcriptPage: (sessionId: number, window: { from?: number; aroundLine?: number }) => Promise<TranscriptPage>
  exportSession: (
    sessionId: number,
    format: SessionExportFormat,
    opts: SessionExportOptions,
    locale: 'ko' | 'en',
  ) => Promise<MaskedText>
  /** Context to paste into a new session when the old one can no longer be resumed. */
  handoffPrompt: (sessionId: number, locale: 'ko' | 'en') => Promise<MaskedText>
  /** The global shortcut was pressed. */
  onFocusSearch: (cb: () => void) => () => void
  onArchiveNews: (cb: (n: ArchiveNews) => void) => () => void
}

declare global {
  interface Window {
    vault: VaultApi
  }
}

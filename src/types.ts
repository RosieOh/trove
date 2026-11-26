
export type Tab = 'search' | 'sessions' | 'prompts' | 'files' | 'favorites' | 'templates' | 'stats' | 'export' | 'settings'

export type TranscriptOpen = {
  sessionId: number
  /** sessions.rel_path — 세션마다 다름 (제목 앞줄) */
  sessionFile: string
  /** projects.display_name 또는 slug */
  projectLabel: string
  highlightLine: number
}

export type PlanPreviewOpen = {
  planId: number
  title: string
  filePath: string
}

export type Command = { id: string; label: string; hint?: string; run: () => void }

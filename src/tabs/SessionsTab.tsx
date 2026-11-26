import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArchiveNews, ProjectRow, SessionListRow, SessionSort } from '../../shared/ipc'
import { useI18n } from '../i18n'
import { Icon, ProjectPicker, Segmented, sidebarPrimaryLabel } from '../ui'
import { formatTs } from '../format'
import { BCP47 } from '../../shared/i18n'
import type { TranscriptOpen } from '../types'

const PAGE = 50
type ArchivedFilter = 'all' | 'archived' | 'live'

const DAY = 86_400_000

/** Group label for a time: today, yesterday, this week, then by month. */
function dayGroup(ms: number, locale: string, t: ReturnType<typeof useI18n>['t']): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= today) return t('sessions.group.today')
  if (ms >= today - DAY) return t('sessions.group.yesterday')
  if (ms >= today - 6 * DAY) return t('sessions.group.week')
  return new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'long' })
}

/**
 * Every session, browsable without a search term: by project, newest first, with the
 * ones only the vault still holds one click away. Subagent transcripts are counted on
 * the session that started them and opened from its transcript.
 */
export function SessionsTab({
  projects,
  projectId,
  onProjectChange,
  onOpenSession,
  onStatus,
  refreshKey,
  archiveNews,
}: {
  projects: ProjectRow[]
  projectId: number | undefined
  onProjectChange: (id: number | undefined) => void
  onOpenSession: (o: TranscriptOpen) => void
  onStatus: (message: string) => void
  refreshKey: number
  archiveNews: ArchiveNews | null
}) {
  const { locale, t } = useI18n()
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState<ArchivedFilter>('all')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [rows, setRows] = useState<SessionListRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState(-1)
  const seq = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(
    async (offset: number) => {
      const my = ++seq.current
      setLoading(true)
      try {
        const res = await window.vault.sessionsList({ projectId, query, archived, sort, offset, limit: PAGE })
        if (my !== seq.current) return
        setRows((prev) => (offset === 0 ? res.rows : [...prev, ...res.rows]))
        setTotal(res.total)
      } finally {
        if (my === seq.current) setLoading(false)
      }
    },
    [projectId, query, archived, sort],
  )

  useEffect(() => {
    const id = setTimeout(() => void load(0), 180)
    return () => clearTimeout(id)
  }, [load, refreshKey])

  useEffect(() => setActive(-1), [projectId, query, archived, sort])

  /** Date headings make sense only for time order. */
  const groups = useMemo(() => {
    if (sort === 'longest') return null
    const labels = rows.map((r) => dayGroup(r.lastTsMs ?? r.mtime, BCP47[locale], t))
    return labels.map((l, i) => (i === 0 || labels[i - 1] !== l ? l : null))
  }, [rows, sort, locale, t])

  const open = useCallback(
    (s: SessionListRow) =>
      onOpenSession({ sessionId: s.sessionId, sessionFile: s.sessionFile, projectLabel: s.projectName, highlightLine: -1 }),
    [onOpenSession],
  )

  const archivedTotal = projects.reduce((n, p) => n + (projectId == null || p.id === projectId ? p.archivedCount : 0), 0)

  const resume = async (s: SessionListRow) => {
    const d = await window.vault.sessionDetail(s.sessionId)
    if (!d) return
    if (d.resumeCommand && d.archivedAt == null) {
      const masked = await window.vault.copyText(d.resumeCommand)
      onStatus(masked > 0 ? t('toast.copiedMasked', { count: masked }) : t('toast.resumeCopied'))
    } else {
      const h = await window.vault.handoffPrompt(s.sessionId, locale)
      await window.vault.copyText(h.text)
      onStatus(t('toast.handoffCopied'))
    }
  }

  // ↑/↓ move, Enter opens, R copies the resume command (or the context of an archived one).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (document.querySelector('[role="dialog"]') || !rows.length) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (e.key === 'ArrowDown' ? Math.min(a + 1, rows.length - 1) : Math.max(a - 1, 0)))
      } else if (e.key === 'Enter' && active >= 0 && rows[active]) {
        e.preventDefault()
        open(rows[active])
      } else if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && active >= 0 && rows[active]) {
        e.preventDefault()
        void resume(rows[active])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (active < 0) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="page page-fill">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5">
        <label className="search-field glass">
          <Icon name="search" className="h-[18px] w-[18px] text-ink-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sessions.placeholder')}
            aria-label={t('sessions.search')}
          />
          {query && (
            <button type="button" className="icon-btn" onClick={() => setQuery('')} aria-label={t('search.clear')}>
              <Icon name="close" />
            </button>
          )}
        </label>
        <ProjectPicker projects={projects} value={projectId} onChange={onProjectChange} />
        <Segmented
          label={t('sessions.filter')}
          value={archived}
          onChange={setArchived}
          options={
            [
              ['all', t('sessions.filter.all')],
              ['live', t('sessions.filter.live')],
              ['archived', t('sessions.filter.archived')],
            ] as const
          }
        />
        <Segmented
          label={t('inspector.sort')}
          value={sort}
          onChange={setSort}
          options={
            [
              ['recent', t('sessions.sort.recent')],
              ['oldest', t('sessions.sort.oldest')],
              ['longest', t('sessions.sort.longest')],
            ] as const
          }
        />
      </div>

      <div className="scroll-area flex min-h-0 flex-1 flex-col gap-4">
        {(archivedTotal > 0 || archiveNews) && (
          <p className="alert tone-amber flex flex-wrap items-center gap-2">
            <span>
              {archiveNews && archiveNews.newlyArchived > 0
                ? t('sessions.archivedNews', { count: archiveNews.newlyArchived, total: archiveNews.totalArchived })
                : t('sessions.archivedSummary', { count: archivedTotal.toLocaleString() })}
            </span>
            {archived !== 'archived' && (
              <button type="button" className="font-semibold underline" onClick={() => setArchived('archived')}>
                {t('sessions.showArchived')}
              </button>
            )}
          </p>
        )}

        <p className="text-[13px] text-ink-3 tabular">
          {loading && !rows.length ? t('common.loading') : t('sessions.count', { shown: rows.length.toLocaleString(), total: total.toLocaleString() })}
        </p>

        {!loading && rows.length === 0 && (
          <div className="list glass">
            <p className="empty">{t('sessions.empty')}</p>
          </div>
        )}

        {rows.length > 0 && (
          <div className="list glass" ref={listRef}>
            {rows.map((s, i) => (
              <Fragment key={s.sessionId}>
                {groups?.[i] && <h3 className="eyebrow px-3.5 pb-1 pt-3">{groups[i]}</h3>}
                <div className="row group flex items-start gap-2" data-index={i} data-active={i === active || undefined}>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(s)} onFocus={() => setActive(i)}>
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-[14.5px] font-semibold text-ink-1">
                        {s.title || s.preview || s.sessionFile}
                      </span>
                      {s.archived && (
                        <span className="badge tone-amber" title={t('badge.archived.hint')}>
                          {t('badge.archived')}
                        </span>
                      )}
                      {s.tool !== 'claude' && <span className="badge tone-violet">{s.tool}</span>}
                    </span>
                    {s.title && s.preview ? <span className="mt-0.5 block truncate text-[13px] text-ink-2">{s.preview}</span> : null}
                    <span className="row-meta mt-1">
                      <span className="truncate font-semibold text-ink-2" title={s.projectName}>
                        {sidebarPrimaryLabel(s.projectName)}
                      </span>
                      {s.gitBranch && <span className="badge tone-gray mono">{s.gitBranch}</span>}
                      <span className="tabular">{formatTs(s.lastTsMs ?? s.mtime, locale)}</span>
                      <span className="tabular">{t('session.rows', { count: s.messageCount.toLocaleString() })}</span>
                      {s.subagentCount > 0 && (
                        <span className="badge tone-blue tabular">{t('session.subagents', { count: s.subagentCount })}</span>
                      )}
                    </span>
                  </button>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-tertiary btn-xs"
                      title={s.archived ? t('session.handoff.hint') : t('session.resume.hint')}
                      onClick={() => void resume(s)}
                    >
                      {s.archived ? t('session.handoff') : t('session.resume')}
                      <span className="kbd ml-1" aria-hidden>
                        R
                      </span>
                    </button>
                  </div>
                </div>
              </Fragment>
            ))}
          </div>
        )}

        {rows.length > 0 && <p className="text-[12.5px] text-ink-3">{t('sessions.keys')}</p>}

        {rows.length < total && (
          <div className="pb-4 text-center">
            <button type="button" className="btn btn-tertiary" disabled={loading} onClick={() => void load(rows.length)}>
              {loading ? t('common.loading') : t('sessions.more', { count: Math.min(PAGE, total - rows.length) })}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

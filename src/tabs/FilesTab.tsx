import { useEffect, useState } from 'react'
import type { FileRow, FileTouchRow } from '../../shared/ipc'
import { parseToolEdits, type ToolEdit } from '../../shared/toolDiff'
import { DiffView } from '../components/DiffView'
import { useI18n } from '../i18n'
import { Icon, RoleBadge, sidebarPrimaryLabel } from '../ui'
import { formatTs } from '../format'
import type { TranscriptOpen } from '../types'

/** The change one tool call made to this file, fetched on demand (bodies can be large). */
function TouchDiff({ messageId, path }: { messageId: number; path: string }) {
  const { t } = useI18n()
  const [edits, setEdits] = useState<ToolEdit[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.vault.messageBody(messageId).then((body) => {
      if (!cancelled) setEdits(parseToolEdits(body))
    })
    return () => {
      cancelled = true
    }
  }, [messageId])
  if (!edits) return <p className="mt-2 text-[12.5px] text-ink-3">{t('common.loading')}</p>
  const mine = edits.filter((e) => e.filePath === path)
  if (!mine.length) return <p className="mt-2 text-[12.5px] text-ink-3">{t('diff.none')}</p>
  return (
    <div className="mt-2">
      <DiffView edits={mine} />
    </div>
  )
}

/** Tool calls that change a file, as opposed to reading it. */
const EDITING = /^\[도구\] (Edit|MultiEdit|Write|NotebookEdit)\b/m

/**
 * File reverse-index. A file is normally buried inside a tool payload, so full-text
 * search rarely surfaces it — this answers "when did I last touch this file, in
 * which session, and on what branch" directly.
 */
export function FilesTab({ onOpenSession }: { onOpenSession: (o: TranscriptOpen) => void }) {
  const { locale, t } = useI18n()
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<FileRow[]>([])
  const [selected, setSelected] = useState<FileRow | null>(null)
  const [timeline, setTimeline] = useState<FileTouchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [openDiffs, setOpenDiffs] = useState<Set<number>>(new Set())
  const [editsOnly, setEditsOnly] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      void window.vault.filesList(query).then((rows) => {
        if (cancelled) return
        setFiles(rows)
        setLoading(false)
      })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  useEffect(() => {
    if (!selected) {
      setTimeline([])
      return
    }
    let cancelled = false
    void window.vault.fileTimeline(selected.path).then((rows) => {
      if (!cancelled) setTimeline(rows)
    })
    return () => {
      cancelled = true
    }
  }, [selected])

  return (
    <div className="page page-fill">
      <div className="flex min-h-0 flex-1 gap-4">
        <section className="list glass flex w-[380px] shrink-0 flex-col">
          <div className="px-2 pb-2 pt-2">
            <label className="search-field !h-10 bg-well !shadow-none">
              <Icon name="search" className="text-ink-3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('files.placeholder')}
                aria-label={t('files.search')}
              />
            </label>
            <p className="mt-2 px-1 text-[12.5px] text-ink-3 tabular">
              {loading ? t('common.loading') : t('files.count', { count: files.length })}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!loading && files.length === 0 && <p className="empty">{t('files.empty')}</p>}
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelected(f)}
                className="row"
                aria-current={selected?.path === f.path ? 'true' : undefined}
              >
                <span className="flex items-baseline gap-2">
                  <span className={`min-w-0 truncate font-semibold ${selected?.path === f.path ? 'text-brand-ink' : 'text-ink-1'}`}>
                    {f.basename}
                  </span>
                  <span className="ml-auto shrink-0 text-[12px] text-ink-3 tabular">
                    {t('files.touches', { touches: f.touches, sessions: f.sessions })}
                  </span>
                </span>
                <span className="mono mt-1 block truncate text-ink-3">{f.path}</span>
                {f.lastTouched ? (
                  <span className="mt-0.5 block text-[12px] text-ink-3 tabular">{formatTs(f.lastTouched, locale)}</span>
                ) : null}
              </button>
            ))}
          </div>
        </section>

        <section className="list glass min-w-0 flex-1 overflow-y-auto">
          {!selected ? (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div>
                <p className="text-[15px] font-semibold text-ink-1">{t('files.selectPrompt')}</p>
                <p className="mt-1 text-[13.5px] text-ink-3">{t('files.selectHint')}</p>
              </div>
            </div>
          ) : (
            <>
              <div className="px-3.5 pb-3 pt-3">
                <h2 className="section-title truncate">{selected.basename}</h2>
                <p className="mono mt-0.5 truncate text-ink-3">{selected.path}</p>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
                  <input type="checkbox" className="check" checked={editsOnly} onChange={(e) => setEditsOnly(e.target.checked)} />
                  {t('files.editsOnly')}
                </label>
              </div>
              {timeline.filter((row) => !editsOnly || EDITING.test(row.preview)).map((row) => (
                <article key={row.messageId} className="row">
                  <div className="flex items-start gap-2">
                    <div className="row-meta flex-1">
                      <RoleBadge role={row.role} />
                      <span className="truncate font-semibold text-ink-2">{sidebarPrimaryLabel(row.projectName)}</span>
                      {row.gitBranch ? <span className="badge tone-gray mono">{row.gitBranch}</span> : null}
                      {row.tsMs ? <span className="tabular">{formatTs(row.tsMs, locale)}</span> : null}
                    </div>
                    {EDITING.test(row.preview) && (
                      <button
                        type="button"
                        className="btn btn-tertiary btn-xs shrink-0"
                        aria-expanded={openDiffs.has(row.messageId)}
                        onClick={() =>
                          setOpenDiffs((prev) => {
                            const n = new Set(prev)
                            if (n.has(row.messageId)) n.delete(row.messageId)
                            else n.add(row.messageId)
                            return n
                          })
                        }
                      >
                        {openDiffs.has(row.messageId) ? t('diff.hide') : t('diff.show')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs shrink-0"
                      onClick={() =>
                        onOpenSession({
                          sessionId: row.sessionId,
                          sessionFile: row.sessionFile,
                          projectLabel: row.projectName,
                          highlightLine: row.lineIndex,
                        })
                      }
                    >
                      {t('action.openSession')}
                    </button>
                  </div>
                  <p className="mono mt-1.5 line-clamp-2 whitespace-pre-wrap break-words leading-[1.55] text-ink-2 [overflow-wrap:anywhere]">
                    {row.preview}
                  </p>
                  {openDiffs.has(row.messageId) && <TouchDiff messageId={row.messageId} path={selected.path} />}
                </article>
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

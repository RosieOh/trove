import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionDetail, SessionMessageRow } from '../../shared/ipc'
import { costOf, formatUsd, type ModelPrice } from '../../shared/pricing'
import { parseToolEdits } from '../../shared/toolDiff'
import { chatAlignForDialog, chatBubbleShellClass, chatRowFlex, isMessageHit } from '../chatBubbleLayout'
import { Icon, RoleBadge, sidebarPrimaryLabel } from '../ui'
import { Markdown } from '../Markdown'
import { useI18n } from '../i18n'
import { formatCompact, formatTs, messageClassKey } from '../format'
import type { TranscriptOpen } from '../types'
import { DiffView } from './DiffView'

/** Rows rendered per step, and the point where a body gets clamped. */
const TRANSCRIPT_PAGE = 150
const MAX_INLINE_BODY = 8000

/** A single message body can exceed 700 KB; clamp it behind an explicit expand. */
function TranscriptBody({ body, markdown }: { body: string; markdown: boolean }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const oversized = body.length > MAX_INLINE_BODY
  const text = oversized && !expanded ? body.slice(0, MAX_INLINE_BODY) : body

  return (
    <>
      {markdown ? (
        <div className="max-h-[min(70vh,32rem)] max-w-full overflow-auto">
          <Markdown>{text}</Markdown>
        </div>
      ) : (
        <pre className="mono max-h-[min(70vh,32rem)] max-w-full overflow-auto whitespace-pre-wrap break-words leading-[1.6] text-ink-2 [overflow-wrap:anywhere]">
          {text}
        </pre>
      )}
      {oversized && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[12.5px] font-semibold text-brand-ink hover:underline"
        >
          {expanded
            ? t('action.collapse')
            : t('transcript.clamped', {
                total: (body.length / 1024).toFixed(0),
                shown: (MAX_INLINE_BODY / 1024).toFixed(0),
              })}
        </button>
      )}
    </>
  )
}

/** A tool call that edits files reads best as a diff; the raw call stays one click away. */
function ToolCallBody({ body, markdown }: { body: string; markdown: boolean }) {
  const { t } = useI18n()
  const edits = useMemo(() => parseToolEdits(body), [body])
  const [raw, setRaw] = useState(false)
  if (!edits.length) return <TranscriptBody body={body} markdown={markdown} />
  return (
    <div className="flex flex-col gap-2">
      {raw ? <TranscriptBody body={body} markdown={false} /> : <DiffView edits={edits} />}
      <button type="button" className="self-start text-[12.5px] font-semibold text-brand-ink hover:underline" onClick={() => setRaw((v) => !v)}>
        {raw ? t('diff.showDiff') : t('diff.showRaw')}
      </button>
    </div>
  )
}

/**
 * Tool activity = a tool call (`tool_use`) or a tool result (re-attributed to the
 * `tool` role). Hidden by default so a session reads as the actual conversation.
 */
function isToolRow(m: SessionMessageRow): boolean {
  return m.role === 'tool' || m.contentKinds.includes('tool_use')
}

/**
 * Markdown is right for prose, but it mangles tool payloads: `__pycache__`
 * becomes bold and Windows paths lose their backslashes. Render those verbatim.
 */
function shouldRenderMarkdown(m: SessionMessageRow): boolean {
  return m.messageClass === 'dialog' && !isToolRow(m)
}

function sessionCost(d: SessionDetail, prices: ModelPrice[]): number | null {
  let total = 0
  let priced = false
  for (const m of d.tokensByModel) {
    const c = costOf(m.model, m, prices)
    if (c != null) {
      total += c
      priced = true
    }
  }
  return priced ? total : null
}

export function SessionTranscriptModal({
  open,
  onClose,
  onStatus,
}: {
  open: TranscriptOpen
  onClose: () => void
  onStatus?: (message: string) => void
}) {
  const { locale, t } = useI18n()
  /** The session on screen; subagent and parent links switch it in place. */
  const [current, setCurrent] = useState<TranscriptOpen>(open)
  const [rows, setRows] = useState<SessionMessageRow[]>([])
  const [from, setFrom] = useState(0)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [prices, setPrices] = useState<ModelPrice[]>([])
  const [showMeta, setShowMeta] = useState(false)
  const [showMarkdown, setShowMarkdown] = useState(true)
  const [showToolResults, setShowToolResults] = useState(false)
  const [showSubagents, setShowSubagents] = useState(false)
  const highlightRef = useRef<HTMLDivElement | null>(null)
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const findRef = useRef<HTMLInputElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const say = useCallback((m: string) => onStatus?.(m), [onStatus])
  /** The highlighted line: the search hit that opened the session, then find-in-session jumps. */
  const [hl, setHl] = useState(open.highlightLine)
  const [findQuery, setFindQuery] = useState('')
  const [findLines, setFindLines] = useState<number[]>([])
  const [findIdx, setFindIdx] = useState(-1)
  const [findBusy, setFindBusy] = useState(false)

  useEffect(() => setCurrent(open), [open])
  useEffect(() => {
    setHl(current.highlightLine)
    setFindQuery('')
    setFindLines([])
    setFindIdx(-1)
  }, [current])

  const visibleRows = useMemo(() => {
    return rows.filter((m) => (showMeta || m.messageClass !== 'meta') && (showToolResults || !isToolRow(m)))
  }, [rows, showMeta, showToolResults])

  const toolRowCount = useMemo(() => rows.filter(isToolRow).length, [rows])
  const archived = detail?.archivedAt != null

  // Sessions reach ~50k rows. The server sends a window; within it, the rendered slice
  // grows as the user scrolls, and reaching its end asks the server for the next window.
  const [renderLimit, setRenderLimit] = useState(TRANSCRIPT_PAGE)
  const shownRows = useMemo(() => visibleRows.slice(0, renderLimit), [visibleRows, renderLimit])
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const moreOnServer = from + rows.length < total

  useEffect(() => {
    setRenderLimit(TRANSCRIPT_PAGE)
  }, [current.sessionId, showMeta, showToolResults])

  const loadNext = useCallback(async () => {
    if (loadingMore || !moreOnServer) return
    setLoadingMore(true)
    try {
      const page = await window.vault.transcriptPage(current.sessionId, { from: from + rows.length })
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.messageId))
        return [...prev, ...page.rows.filter((r) => !seen.has(r.messageId))]
      })
      setTotal(page.total)
    } finally {
      setLoadingMore(false)
    }
  }, [current.sessionId, from, rows.length, loadingMore, moreOnServer])

  const loadPrevious = async () => {
    if (loadingMore || from === 0) return
    setLoadingMore(true)
    try {
      const start = Math.max(0, from - 2000)
      const page = await window.vault.transcriptPage(current.sessionId, { from: start })
      const before = page.rows.filter((r) => r.lineIndex < (rows[0]?.lineIndex ?? Infinity))
      setRows((prev) => [...before, ...prev])
      setFrom(start)
      setRenderLimit((n) => n + before.length)
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        if (shownRows.length < visibleRows.length) setRenderLimit((n) => n + TRANSCRIPT_PAGE)
        else void loadNext()
      },
      { rootMargin: '400px' },
    )
    io.observe(node)
    return () => io.disconnect()
  }, [shownRows.length, visibleRows.length, loadNext])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    closeBtnRef.current?.focus()
  }, [current.sessionId])

  useEffect(() => {
    void window.vault.pricesList().then(setPrices)
  }, [])

  useEffect(() => {
    let cancelled = false
    setRows([])
    setFrom(0)
    setTotal(0)
    setLoaded(false)
    setLoadErr('')
    setShowMeta(false)
    setDetail(null)
    setShowSubagents(false)
    void window.vault.sessionDetail(current.sessionId).then((d) => {
      if (!cancelled) setDetail(d)
    })
    void window.vault
      .transcriptPage(current.sessionId, current.highlightLine >= 0 ? { aroundLine: current.highlightLine } : { from: 0 })
      .then(
        (page) => {
          if (cancelled) return
          setRows(page.rows)
          setFrom(page.from)
          setTotal(page.total)
          setLoaded(true)
        },
        () => {
          if (!cancelled) setLoadErr(t('transcript.loadError'))
        },
      )
    return () => {
      cancelled = true
    }
  }, [current.sessionId, current.highlightLine, t])

  // The highlighted row may sit past the first rendered slice: render up to it.
  useEffect(() => {
    if (hl < 0) return
    const idx = visibleRows.findIndex((m) => m.lineIndex === hl)
    if (idx >= renderLimit) setRenderLimit(idx + 20)
  }, [visibleRows, hl, renderLimit])

  useEffect(() => {
    if (!visibleRows.length || hl < 0) return
    const id = window.setTimeout(() => {
      // Scroll the transcript pane only. scrollIntoView would also scroll the dialog itself
      // (programmatically scrollable even with overflow hidden) and push the header away.
      const body = bodyRef.current
      const el = highlightRef.current
      if (!body || !el) return
      const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
      body.scrollTo({ top: Math.max(0, top - body.clientHeight / 2 + el.clientHeight / 2), behavior: 'smooth' })
    }, 120)
    return () => window.clearTimeout(id)
  }, [visibleRows, hl])

  // Find in this session: the same search as the Search tab, narrowed to this session and
  // to the rows on screen (meta and tool rows only when they are shown).
  useEffect(() => {
    const q = findQuery.trim()
    if (!q) {
      setFindLines([])
      setFindIdx(-1)
      return
    }
    let cancelled = false
    setFindBusy(true)
    const id = window.setTimeout(() => {
      void window.vault
        .search({
          query: q,
          sessionId: current.sessionId,
          excludeMeta: !showMeta,
          excludeTools: !showToolResults,
          sort: 'oldest',
          limit: 200,
          scope: 'messages',
        })
        .then((hits) => {
          if (cancelled || !hits) return
          const lines = [...new Set(hits.filter(isMessageHit).map((h) => h.lineIndex))].sort((a, b) => a - b)
          setFindLines(lines)
          setFindIdx(-1)
        })
        .finally(() => {
          if (!cancelled) setFindBusy(false)
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [findQuery, current.sessionId, showMeta, showToolResults])

  /** Moves to a find result, loading the window around it when it is not loaded yet. */
  const jumpTo = async (i: number) => {
    if (!findLines.length) return
    const n = (i + findLines.length) % findLines.length
    const line = findLines[n]
    setFindIdx(n)
    if (!rows.some((r) => r.lineIndex === line)) {
      const page = await window.vault.transcriptPage(current.sessionId, { aroundLine: line })
      setRows(page.rows)
      setFrom(page.from)
      setTotal(page.total)
      setRenderLimit(TRANSCRIPT_PAGE)
    }
    setHl(line)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        findRef.current?.focus()
        findRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const copy = async (text: string, okKey: 'toast.copied' | 'toast.resumeCopied' | 'toast.handoffCopied' = 'toast.copied') => {
    const masked = await window.vault.copyText(text)
    say(masked > 0 ? t('toast.copiedMasked', { count: masked }) : t(okKey))
  }

  /** The whole session, not just the loaded window. */
  const copyAll = async () => {
    const r = await window.vault.exportSession(current.sessionId, 'md', { includeTools: showToolResults, includeMeta: showMeta }, locale)
    await copy(r.text)
  }

  const saveAs = async (format: 'md' | 'html') => {
    const r = await window.vault.exportSession(current.sessionId, format, { includeTools: showToolResults, includeMeta: showMeta }, locale)
    const res = await window.vault.exportSave(r.text, format)
    if (res.saved) say(r.masked > 0 ? t('toast.savedMasked', { path: res.path ?? '', count: r.masked }) : t('toast.saved', { path: res.path ?? '' }))
    else if (res.error === 'claude-home') say(t('toast.saveBlocked'))
    else if (res.error) say(t('toast.saveFailed', { error: res.error }))
  }

  const copyHandoff = async () => {
    const r = await window.vault.handoffPrompt(current.sessionId, locale)
    await copy(r.text, 'toast.handoffCopied')
  }

  const cost = detail ? sessionCost(detail, prices) : null
  const tokens = detail?.tokensByModel.reduce((n, m) => n + m.input + m.output + m.cacheRead + m.cacheCreation, 0) ?? 0
  const canResume = detail?.resumeCommand != null && !archived

  return (
    <div className="scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog glass-solid max-w-4xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transcript-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 flex-col gap-3 border-b border-line px-6 pb-4 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="transcript-title" className="truncate text-[19px] font-bold tracking-[-0.03em] text-ink-1" title={detail?.title ?? undefined}>
                {detail?.title || t('transcript.title')}
              </h2>
              <p className="mt-0.5 truncate text-[13.5px] text-ink-2" title={current.projectLabel}>
                {current.projectLabel}
              </p>
              <p className="mono mt-0.5 break-all text-ink-3" title={detail?.sessionFile ?? current.sessionFile}>
                {detail?.sessionFile ?? current.sessionFile}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button ref={closeBtnRef} type="button" className="icon-btn" onClick={onClose} aria-label={t('action.close')}>
                <Icon name="close" />
              </button>
            </div>
          </div>

          {detail && (
            <div className="row-meta">
              {detail.gitBranch && <span className="badge tone-gray mono">{detail.gitBranch}</span>}
              {detail.firstTsMs != null && (
                <span className="tabular">
                  {formatTs(detail.firstTsMs, locale)}
                  {detail.lastTsMs != null && detail.lastTsMs !== detail.firstTsMs ? ` – ${formatTs(detail.lastTsMs, locale)}` : ''}
                </span>
              )}
              <span className="tabular">{t('session.prompts', { count: detail.promptCount.toLocaleString() })}</span>
              <span className="tabular">{t('session.rows', { count: detail.messageCount.toLocaleString() })}</span>
              {detail.filesTouched > 0 && <span className="tabular">{t('session.files', { count: detail.filesTouched })}</span>}
              {tokens > 0 && <span className="tabular">{t('session.tokens', { count: formatCompact(tokens) })}</span>}
              {cost != null && (
                <span className="tabular" title={t('cost.footnote')}>
                  ≈ {formatUsd(cost)}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {canResume && (
              <button
                type="button"
                className="btn btn-primary btn-xs"
                title={detail!.resumeCommand!}
                onClick={() => void copy(detail!.resumeCommand!, 'toast.resumeCopied')}
              >
                {t('session.resume')}
              </button>
            )}
            {canResume && detail?.forkCommand && (
              <button type="button" className="btn btn-tertiary btn-xs" title={detail.forkCommand} onClick={() => void copy(detail.forkCommand!, 'toast.resumeCopied')}>
                {t('session.fork')}
              </button>
            )}
            {detail && (
              <button
                type="button"
                className={`btn btn-xs ${canResume ? 'btn-tertiary' : 'btn-primary'}`}
                title={t('session.handoff.hint')}
                onClick={() => void copyHandoff()}
              >
                {t('session.handoff')}
              </button>
            )}
            <span className="mx-1 h-4 w-px bg-line-strong" aria-hidden />
            <button type="button" className="btn btn-tertiary btn-xs" onClick={() => void copyAll()}>
              {t('action.copyAll')}
            </button>
            <button type="button" className="btn btn-tertiary btn-xs" onClick={() => void saveAs('md')}>
              {t('session.saveMd')}
            </button>
            <button type="button" className="btn btn-tertiary btn-xs" onClick={() => void saveAs('html')}>
              {t('session.saveHtml')}
            </button>
            {detail?.parentSessionId != null && (
              <button
                type="button"
                className="btn btn-tertiary btn-xs"
                onClick={() =>
                  setCurrent({ sessionId: detail.parentSessionId!, sessionFile: '', projectLabel: current.projectLabel, highlightLine: -1 })
                }
              >
                {t('session.openParent')}
              </button>
            )}
            {detail && detail.subagents.length > 0 && (
              <button
                type="button"
                className="btn btn-tertiary btn-xs"
                aria-expanded={showSubagents}
                onClick={() => setShowSubagents((v) => !v)}
              >
                {t('session.subagents', { count: detail.subagents.length })}
                <Icon name="chevron" className={showSubagents ? 'rotate-180' : ''} />
              </button>
            )}
          </div>

          {showSubagents && detail && (
            <ol className="list bg-well !p-1">
              {detail.subagents.map((a) => (
                <li key={a.sessionId}>
                  <button
                    type="button"
                    className="row !py-2"
                    onClick={() => setCurrent({ sessionId: a.sessionId, sessionFile: a.sessionFile, projectLabel: current.projectLabel, highlightLine: -1 })}
                  >
                    <span className="flex items-baseline gap-2 text-[13px]">
                      <span className="min-w-0 truncate font-semibold text-ink-1">{a.title || a.preview || a.sessionFile}</span>
                      <span className="ml-auto shrink-0 text-[12px] text-ink-3 tabular">
                        {a.firstTsMs != null ? formatTs(a.firstTsMs, locale) : ''} · {t('session.rows', { count: a.messageCount })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {archived && <p className="alert tone-amber">{t('transcript.archived')}</p>}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink-2">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="check" checked={showMeta} onChange={(e) => setShowMeta(e.target.checked)} />
              {t('transcript.showMeta')}
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="check" checked={showMarkdown} onChange={(e) => setShowMarkdown(e.target.checked)} />
              {t('transcript.markdown')}
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="check"
                checked={showToolResults}
                onChange={(e) => setShowToolResults(e.target.checked)}
              />
              {t('transcript.showTools')}
              {toolRowCount > 0 ? <span className="text-ink-3 tabular">{toolRowCount.toLocaleString()}</span> : null}
            </label>
            <div className="ml-auto flex items-center gap-1.5">
              <label className="search-field !h-8 !rounded-full bg-well !px-3 !shadow-none">
                <Icon name="search" className="h-3.5 w-3.5 text-ink-3" />
                <input
                  ref={findRef}
                  value={findQuery}
                  onChange={(e) => setFindQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void jumpTo(e.shiftKey ? findIdx - 1 : findIdx + 1)
                    } else if (e.key === 'Escape' && findQuery) {
                      e.stopPropagation()
                      setFindQuery('')
                    }
                  }}
                  placeholder={t('transcript.find')}
                  aria-label={t('transcript.find')}
                  className="!w-40 !text-[13px]"
                />
              </label>
              {findQuery.trim() && (
                <>
                  <span className="min-w-[3.5rem] text-center text-[12.5px] text-ink-3 tabular" aria-live="polite">
                    {findBusy
                      ? '…'
                      : findLines.length
                        ? `${findIdx >= 0 ? findIdx + 1 : 0}/${findLines.length}${findLines.length >= 200 ? '+' : ''}`
                        : t('transcript.find.none')}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={!findLines.length}
                    onClick={() => void jumpTo(findIdx - 1)}
                    aria-label={t('transcript.find.prev')}
                  >
                    <Icon name="chevron" className="rotate-180" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={!findLines.length}
                    onClick={() => void jumpTo(findIdx + 1)}
                    aria-label={t('transcript.find.next')}
                  >
                    <Icon name="chevron" />
                  </button>
                </>
              )}
            </div>
          </div>

        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-transcript-body title={t('transcript.hint')}>
          {loadErr && <p className="alert tone-rose">{loadErr}</p>}
          {!loadErr && !loaded && <p className="empty">{t('common.loading')}</p>}
          {from > 0 && (
            <div className="mb-4 text-center">
              <button type="button" className="btn btn-tertiary btn-xs" disabled={loadingMore} onClick={() => void loadPrevious()}>
                {t('transcript.loadEarlier', { count: from.toLocaleString() })}
              </button>
            </div>
          )}
          {(() => {
            const hiddenMeta = showMeta ? 0 : rows.filter((m) => m.messageClass === 'meta').length
            const hiddenTools = showToolResults ? 0 : toolRowCount
            if (!hiddenMeta && !hiddenTools) return null
            const bits = [
              hiddenMeta ? t('transcript.hidden.meta', { count: hiddenMeta.toLocaleString() }) : '',
              hiddenTools ? t('transcript.hidden.tools', { count: hiddenTools.toLocaleString() }) : '',
            ].filter(Boolean)
            return <p className="mb-4 text-center text-[12.5px] text-ink-3">{t('transcript.hidden', { parts: bits.join(' · ') })}</p>
          })()}
          <div className="flex flex-col gap-3">
            {shownRows.map((m) => {
              const isHi = m.lineIndex === hl
              const align = chatAlignForDialog(m.role, m.messageClass)
              const mcKey = messageClassKey(m.messageClass)
              const markdown = showMarkdown && shouldRenderMarkdown(m)
              return (
                <div key={m.messageId} className={`flex w-full min-w-0 ${chatRowFlex(align)}`}>
                  <div
                    ref={isHi ? highlightRef : undefined}
                    className={chatBubbleShellClass(align)}
                    data-highlight={isHi || undefined}
                    aria-label={`${m.role} · ${m.lineIndex}`}
                  >
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                      {align !== 'center' ? <RoleBadge role={m.role} /> : null}
                      {mcKey ? <span className="badge tone-gray">{t(mcKey)}</span> : null}
                      <span className="mono">#{m.lineIndex}</span>
                      <button type="button" className="ml-auto font-semibold text-brand-ink hover:underline" onClick={() => void copy(m.body)}>
                        {t('action.copy')}
                      </button>
                    </div>
                    {m.contentKinds.includes('tool_use') ? (
                      <ToolCallBody body={m.body} markdown={markdown} />
                    ) : (
                      <TranscriptBody body={m.body} markdown={markdown} />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {(shownRows.length < visibleRows.length || moreOnServer) && (
            <div ref={sentinelRef} className="py-5 text-center text-[12.5px] text-ink-3 tabular">
              {t('transcript.more', {
                shown: (from + shownRows.length).toLocaleString(),
                total: total.toLocaleString(),
              })}
            </div>
          )}
          {loaded && !moreOnServer && shownRows.length >= visibleRows.length && total > 0 && detail && (
            <p className="py-4 text-center text-[12.5px] text-ink-3">
              {sidebarPrimaryLabel(current.projectLabel)} · {t('transcript.end')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

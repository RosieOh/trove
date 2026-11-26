import { useMemo, useState } from 'react'
import { diffLines, type DiffLine, type ToolEdit } from '../../shared/toolDiff'
import { useT } from '../i18n'

/** Unchanged lines kept around each change; longer unchanged runs fold. */
const CONTEXT = 3
/** A Write of a large file is shown up to here, behind an explicit expand. */
const MAX_LINES = 400

type Chunk = { kind: 'lines'; lines: DiffLine[] } | { kind: 'gap'; count: number }

function fold(lines: DiffLine[]): Chunk[] {
  const keep = lines.map(() => false)
  lines.forEach((l, i) => {
    if (l.kind === 'same') return
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep[k] = true
  })
  const out: Chunk[] = []
  let gap = 0
  let cur: DiffLine[] = []
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ kind: 'gap', count: gap })
      gap = 0
      cur.push(l)
    } else {
      if (cur.length) out.push({ kind: 'lines', lines: cur })
      cur = []
      gap += 1
    }
  })
  if (cur.length) out.push({ kind: 'lines', lines: cur })
  if (gap) out.push({ kind: 'gap', count: gap })
  return out
}

function Hunk({ before, after }: { before: string; after: string }) {
  const t = useT()
  const [all, setAll] = useState(false)
  const lines = useMemo(() => diffLines(before, after), [before, after])
  const shown = all ? lines : lines.slice(0, MAX_LINES)
  const chunks = useMemo(() => fold(shown), [shown])
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12px] text-ink-3 tabular">
        <span className="text-tone-green">+{added}</span> <span className="text-tone-rose">−{removed}</span>
      </p>
      <div className="diff mono" role="figure" aria-label={t('diff.label', { added, removed })}>
        {chunks.map((c, i) =>
          c.kind === 'gap' ? (
            <div key={i} className="diff-gap">
              {t('diff.folded', { count: c.count })}
            </div>
          ) : (
            c.lines.map((l, j) => (
              <div key={`${i}-${j}`} className={`diff-line ${l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : ''}`}>
                <span className="diff-sign" aria-hidden>
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                </span>
                <span>
                  <span className="sr-only">{l.kind === 'add' ? t('diff.added') : l.kind === 'del' ? t('diff.removed') : ''}</span>
                  {l.text || ' '}
                </span>
              </div>
            ))
          ),
        )}
      </div>
      {lines.length > MAX_LINES && (
        <button type="button" className="self-start text-[12.5px] font-semibold text-brand-ink hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? t('action.collapse') : t('diff.showAll', { count: lines.length })}
        </button>
      )}
    </div>
  )
}

/** Before/after view of the file edits in one tool call message. */
export function DiffView({ edits, onlyPath }: { edits: ToolEdit[]; onlyPath?: string }) {
  const t = useT()
  const list = onlyPath ? edits.filter((e) => e.filePath === onlyPath) : edits
  if (!list.length) return null
  return (
    <div className="flex flex-col gap-3">
      {list.map((e, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            <span className="badge tone-violet">{e.isCreate ? t('diff.write') : e.tool}</span>
            <span className="mono break-all text-ink-3">{e.filePath}</span>
          </p>
          {e.edits.map((h, j) => (
            <Hunk key={j} before={h.oldText} after={h.newText} />
          ))}
        </div>
      ))}
    </div>
  )
}

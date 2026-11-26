import { useEffect, useMemo, useState } from 'react'
import type { ModelTokenRow, ProjectUsageRow, StatsPayload, ToolUsageRow, UsageBlock } from '../../shared/ipc'
import { OPENAI_PRICES_AS_OF, PRICES_AS_OF, costOf, formatUsd, type ModelPrice } from '../../shared/pricing'
import { BCP47 } from '../../shared/i18n'
import { useI18n, useT } from '../i18n'
import { GHOST_BTN } from '../ui'
import { formatCompact } from '../format'
import { openWeeks, TARGET_DAYS_PER_WEEK } from '../../shared/appOpens'

type CostRow = { model: string; cost: number | null }

/** Per-model cost; zero-token placeholder ids (`<synthetic>`) are dropped first. */
function costRows(byModel: ModelTokenRow[], prices: ModelPrice[]): CostRow[] {
  return byModel
    .filter((m) => m.input + m.output + m.cacheRead + m.cacheCreation > 0)
    .map((m) => ({
      model: m.model,
      cost: costOf(
        m.model,
        { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheCreation: m.cacheCreation, cacheCreation1h: m.cacheCreation1h },
        prices,
      ),
    }))
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
}

function StatTile({ label, value, unit, foot }: { label: string; value: string; unit?: string; foot: string }) {
  return (
    <div className="stat glass">
      <span className="stat-label">{label}</span>
      <div>
        <span className="stat-value">{value}</span>
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      <span className="stat-foot">{foot}</span>
    </div>
  )
}

/** One labelled thin bar: name left, value at the right, bar grows from the left baseline. */
function BarRow({ label, value, fraction, title }: { label: string; value: string; fraction: number; title?: string }) {
  return (
    <div className="flex flex-col gap-1.5" title={title}>
      <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
        <span className="min-w-0 truncate text-ink-1">{label}</span>
        <span className="shrink-0 text-[12.5px] text-ink-3 tabular">{value}</span>
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${Math.max(fraction > 0 ? 1.5 : 0, fraction * 100)}%` }} />
      </div>
    </div>
  )
}

/** Round up to 1/2/5 × 10^k so gridlines land on clean numbers. */
function niceMax(n: number): number {
  if (n <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(n))
  for (const m of [1, 2, 5, 10]) if (n <= m * p) return m * p
  return 10 * p
}

/** Fill missing days with zero so the time axis is continuous. */
function continuousDays(days: { day: string; count: number }[]): { day: string; count: number }[] {
  if (days.length < 2) return days
  const byDay = new Map(days.map((d) => [d.day, d.count]))
  const out: { day: string; count: number }[] = []
  const cur = new Date(`${days[0].day}T00:00:00`)
  const end = new Date(`${days[days.length - 1].day}T00:00:00`)
  while (cur <= end && out.length < 400) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`
    out.push({ day: key, count: byDay.get(key) ?? 0 })
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

/**
 * Prompts per day as thin columns from a shared baseline, with hairline gridlines at
 * clean values, a hover tooltip, and a table view so no value is hover-only.
 */
/**
 * The roadmap's dogfooding check, "opened it on at least three days a week", measured
 * from the local `app_opens` dates: one row of seven cells per week, oldest first.
 */
function OpenDaysPanel({ days }: { days: string[] }) {
  const { locale, t } = useI18n()
  const weeks = useMemo(() => openWeeks(days, new Date()), [days])
  const met = weeks.filter((w) => w.count >= TARGET_DAYS_PER_WEEK).length
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(BCP47[locale], opts)

  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div>
        <h2 className="section-title">{t('stats.opens.title')}</h2>
        <p className="section-desc">{t('stats.opens.desc', { target: TARGET_DAYS_PER_WEEK })}</p>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {weeks.map((w, i) => (
          <div key={w.start} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
              <span className="text-ink-3">
                {i === weeks.length - 1 ? t('stats.opens.thisWeek') : t('stats.opens.weekOf', { date: fmt(w.start, { month: 'short', day: 'numeric' }) })}
              </span>
              <span className="tabular font-semibold text-ink-1">{t('stats.opens.days', { count: w.count })}</span>
            </div>
            <div className="flex gap-1" role="list" aria-label={t('stats.opens.weekOf', { date: fmt(w.start, { month: 'long', day: 'numeric' }) })}>
              {w.days.map((d) => {
                const label = `${fmt(d.day, { month: 'short', day: 'numeric', weekday: 'short' })} · ${
                  d.future ? t('stats.opens.future') : d.opened ? t('stats.opens.opened') : t('stats.opens.notOpened')
                }`
                return (
                  <span
                    key={d.day}
                    role="listitem"
                    title={label}
                    aria-label={label}
                    className={`h-3.5 flex-1 rounded-[4px] ${
                      d.opened ? 'bg-brand' : d.future ? 'border border-dashed border-line' : 'bg-well'
                    }`}
                  />
                )
              })}
            </div>
            {w.count >= TARGET_DAYS_PER_WEEK && <span className="badge tone-green self-start">{t('stats.opens.met')}</span>}
          </div>
        ))}
      </div>
      <p className="text-[13px] text-ink-3">
        {t('stats.opens.summary', { met, weeks: weeks.length, target: TARGET_DAYS_PER_WEEK })}
      </p>
    </section>
  )
}

function ActivityChart({ days }: { days: { day: string; count: number }[] }) {
  const { locale, t } = useI18n()
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const series = useMemo(() => continuousDays(days), [days])
  const top = niceMax(Math.max(1, ...series.map((d) => d.count)))
  const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(BCP47[locale], { month: 'short', day: 'numeric' })
  const total = series.reduce((n, d) => n + d.count, 0)
  const h = hover != null ? series[hover] : null

  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div className="section-head">
        <div>
          <h2 className="section-title">{t('stats.activity.ts')}</h2>
          <p className="section-desc">
            {t('stats.activity.summary', { days: series.length, total: total.toLocaleString() })}
          </p>
        </div>
        <button type="button" className={GHOST_BTN} onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? t('stats.chartView') : t('stats.tableView')}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('stats.table.day')}</th>
                <th className="text-right">{t('stats.table.prompts')}</th>
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((d) => (
                <tr key={d.day}>
                  <td className="tabular">{d.day}</td>
                  <td className="text-right tabular">{d.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative" onMouseLeave={() => setHover(null)}>
          {/* Plot (160px) + x-axis band (22px) — the container includes the axis. */}
          <div className="relative h-[160px]">
            {[top, top / 2, 0].map((v) => (
              <div
                key={v}
                className="absolute left-0 right-0 flex items-center gap-2"
                style={{ bottom: `${(v / top) * 100}%`, transform: 'translateY(50%)' }}
              >
                <span className="w-8 shrink-0 text-right text-[11px] text-ink-3 tabular">{formatCompact(v)}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            ))}
            <div className="absolute bottom-0 left-10 right-0 top-0 flex items-end gap-[2px]">
              {series.map((d, i) => (
                <div
                  key={d.day}
                  className="relative flex h-full min-w-0 flex-1 items-end"
                  onMouseEnter={() => setHover(i)}
                >
                  <div
                    className="w-full rounded-t-[4px] transition-opacity duration-150"
                    style={{
                      height: `${(d.count / top) * 100}%`,
                      minHeight: d.count > 0 ? 2 : 0,
                      background: 'var(--brand)',
                      opacity: hover == null || hover === i ? 1 : 0.45,
                    }}
                  />
                </div>
              ))}
            </div>
            {h && hover != null && (
              <div
                className="menu pointer-events-none !absolute whitespace-nowrap !px-3 !py-2 text-[12.5px]"
                style={{
                  left: `calc(2.5rem + (100% - 2.5rem) * ${(hover + 0.5) / series.length})`,
                  bottom: `calc(${(h.count / top) * 100}% + 10px)`,
                  transform: `translateX(${hover > series.length * 0.75 ? '-100%' : hover < series.length * 0.25 ? '0' : '-50%'})`,
                }}
                role="tooltip"
              >
                <span className="text-ink-3">{fmtDay(h.day)}</span>{' '}
                <span className="font-semibold text-ink-1 tabular">{t('stats.prompts.n', { count: h.count })}</span>
              </div>
            )}
          </div>
          <div className="ml-10 flex h-[22px] items-end justify-between text-[11px] text-ink-3 tabular">
            <span>{series[0] ? fmtDay(series[0].day) : ''}</span>
            <span>{series.length > 2 ? fmtDay(series[Math.floor(series.length / 2)].day) : ''}</span>
            <span>{series.length > 1 ? fmtDay(series[series.length - 1].day) : ''}</span>
          </div>
        </div>
      )}
    </section>
  )
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Cell classes by heat step, spelled out in full so Tailwind keeps the component classes. */
const HEAT = ['heat', 'heat heat-1', 'heat heat-2', 'heat heat-3', 'heat heat-4']

/** Heat step 0–4 relative to the busiest cell, so a quiet year still shows its shape. */
function heatLevel(count: number, max: number): number {
  if (count <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((count / Math.max(1, max)) * 4)))
}

function HeatLegend() {
  const t = useT()
  return (
    <div className="flex items-center justify-end gap-1.5 text-[11px] text-ink-3" aria-hidden>
      <span>{t('stats.heat.less')}</span>
      {[0, 1, 2, 3, 4].map((l) => (
        <span key={l} className={`${HEAT[l]} h-2.5 w-2.5`} />
      ))}
      <span>{t('stats.heat.more')}</span>
    </div>
  )
}

/** Short weekday name; 2026-01-04 was a Sunday, so `weekday` 0–6 maps onto Jan 4–10. */
const weekdayName = (weekday: number, locale: string, style: 'short' | 'long' = 'short') =>
  new Date(2026, 0, 4 + weekday).toLocaleDateString(locale, { weekday: style })

/**
 * Prompts per day over 53 weeks, one column per week (Sunday on top) like a contribution
 * graph. Every cell carries its own label; the table view lists the same numbers.
 */
function YearHeatmap({ days }: { days: { day: string; count: number }[] }) {
  const { locale, t } = useI18n()
  const [asTable, setAsTable] = useState(false)
  const bcp = BCP47[locale]
  const grid = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d.count]))
    const now = new Date()
    const today = dayKey(now)
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - 52 * 7)
    const weeks: { day: string; date: Date; count: number; future: boolean }[][] = []
    for (let w = 0; w < 53; w++) {
      const week = []
      for (let d = 0; d < 7; d++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d)
        const day = dayKey(date)
        week.push({ day, date, count: byDay.get(day) ?? 0, future: day > today })
      }
      weeks.push(week)
    }
    return weeks
  }, [days])
  const max = Math.max(1, ...days.map((d) => d.count))
  const total = days.reduce((n, d) => n + d.count, 0)
  // A month label over the first week that starts in it; skipped when the next one would crowd it.
  const months = grid.flatMap((week, i) => {
    const m = week[0].date.getMonth()
    if (i > 0 && grid[i - 1][0].date.getMonth() === m) return []
    if (i === 0 && grid[2]?.[0].date.getMonth() !== m) return []
    return [{ col: i, label: week[0].date.toLocaleDateString(bcp, { month: 'short' }) }]
  })
  const cols = '2rem repeat(53, minmax(0, 1fr))'

  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div className="section-head">
        <div>
          <h2 className="section-title">{t('stats.year.title')}</h2>
          <p className="section-desc">
            {t('stats.year.desc')} {t('stats.year.summary', { days: days.length, total: total.toLocaleString() })}
          </p>
        </div>
        <button type="button" className={GHOST_BTN} onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? t('stats.chartView') : t('stats.tableView')}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('stats.table.day')}</th>
                <th className="text-right">{t('stats.table.prompts')}</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}>
                  <td className="tabular">{d.day}</td>
                  <td className="text-right tabular">{d.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="grid gap-[3px] text-[11px] text-ink-3" style={{ gridTemplateColumns: cols }} aria-hidden>
            {months.map((m) => (
              <span key={m.col} className="whitespace-nowrap" style={{ gridColumn: m.col + 2, gridRow: 1 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div
            className="grid gap-[3px]"
            style={{ gridTemplateColumns: cols, gridTemplateRows: 'repeat(7, auto)', gridAutoFlow: 'column' }}
            role="group"
            aria-label={t('stats.year.title')}
          >
            {[0, 1, 2, 3, 4, 5, 6].map((wd) => (
              <span key={wd} className="self-center pr-1 text-[10.5px] leading-none text-ink-3" aria-hidden>
                {wd % 2 === 1 ? weekdayName(wd, bcp) : ''}
              </span>
            ))}
            {grid.flat().map((c) => {
              if (c.future) return <span key={c.day} className="heat heat-future aspect-square" aria-hidden />
              const label = `${c.date.toLocaleDateString(bcp, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' })} · ${t('stats.prompts.n', { count: c.count })}`
              return (
                <span
                  key={c.day}
                  role="img"
                  title={label}
                  aria-label={label}
                  className={`${HEAT[heatLevel(c.count, max)]} aspect-square`}
                />
              )
            })}
          </div>
          <HeatLegend />
        </div>
      )}
    </section>
  )
}

/** Weekday rows (Monday first) × 24 hour columns, local time, all prompts ever. */
function HourHeatmap({ cells }: { cells: StatsPayload['activityByHour'] }) {
  const { locale, t } = useI18n()
  const [asTable, setAsTable] = useState(false)
  const bcp = BCP47[locale]
  const at = useMemo(() => {
    const m = new Map<number, number>()
    for (const c of cells) m.set(c.weekday * 24 + c.hour, c.count)
    return m
  }, [cells])
  const max = Math.max(1, ...cells.map((c) => c.count))
  const rows = [1, 2, 3, 4, 5, 6, 0]
  const hours = Array.from({ length: 24 }, (_, h) => h)
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
  const cols = '2.5rem repeat(24, minmax(0, 1fr))'

  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div className="section-head">
        <div>
          <h2 className="section-title">{t('stats.hours.title')}</h2>
          <p className="section-desc">{t('stats.hours.desc')}</p>
        </div>
        <button type="button" className={GHOST_BTN} onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? t('stats.chartView') : t('stats.tableView')}
        </button>
      </div>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="table min-w-[900px]">
            <thead>
              <tr>
                <th>{t('stats.table.weekday')}</th>
                {hours.map((h) => (
                  <th key={h} className="!px-1 text-right">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((wd) => (
                <tr key={wd}>
                  <td>{weekdayName(wd, bcp)}</td>
                  {hours.map((h) => (
                    <td key={h} className="!px-1 text-right tabular">
                      {(at.get(wd * 24 + h) ?? 0).toLocaleString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="grid gap-[3px] text-[11px] text-ink-3 tabular" style={{ gridTemplateColumns: cols }} aria-hidden>
            {[0, 6, 12, 18].map((h) => (
              <span key={h} style={{ gridColumn: h + 2 }}>
                {h}
              </span>
            ))}
          </div>
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: cols }} role="group" aria-label={t('stats.hours.title')}>
            {rows.map((wd) => [
              <span key={`l${wd}`} className="self-center text-[11px] leading-none text-ink-3" aria-hidden>
                {weekdayName(wd, bcp)}
              </span>,
              ...hours.map((h) => {
                const count = at.get(wd * 24 + h) ?? 0
                const label = `${weekdayName(wd, bcp, 'long')} ${hh(h)}–${hh((h + 1) % 24)} · ${t('stats.prompts.n', { count })}`
                return (
                  <span
                    key={`${wd}-${h}`}
                    role="img"
                    title={label}
                    aria-label={label}
                    className={`${HEAT[heatLevel(count, max)]} h-[18px]`}
                  />
                )
              }),
            ])}
          </div>
          <HeatLegend />
        </div>
      )}
    </section>
  )
}

/** Per-project usage, priced per model with the same table as the cost panel. */
function ProjectUsagePanel({ rows, prices }: { rows: ProjectUsageRow[]; prices: ModelPrice[] }) {
  const t = useT()
  const priced = useMemo(
    () =>
      rows.map((p) => {
        const costs = costRows(p.byModel, prices)
        return {
          ...p,
          cost: costs.reduce((n, c) => n + (c.cost ?? 0), 0),
          unpriced: costs.some((c) => c.cost == null),
        }
      }),
    [rows, prices],
  )
  const max = Math.max(1e-9, ...priced.map((p) => p.cost))

  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div>
        <h2 className="section-title">{t('stats.projects.title')}</h2>
        <p className="section-desc">{t('stats.projects.desc')}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="table min-w-[640px]">
          <thead>
            <tr>
              <th>{t('stats.projects.project')}</th>
              <th className="text-right">{t('stats.projects.sessions')}</th>
              <th className="text-right">{t('stats.projects.responses')}</th>
              <th className="text-right">{t('stats.projects.tokens')}</th>
              <th className="w-[28%]">{t('stats.projects.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {priced.map((p) => (
              <tr key={p.projectId}>
                <td className="max-w-[260px] truncate text-ink-1" title={p.projectName}>
                  {p.projectName}
                </td>
                <td className="text-right tabular">{p.sessions.toLocaleString()}</td>
                <td className="text-right tabular">{p.responses.toLocaleString()}</td>
                <td
                  className="text-right tabular"
                  title={t('stats.projects.tokensTitle', {
                    input: formatCompact(p.input),
                    output: formatCompact(p.output),
                    cacheRead: formatCompact(p.cacheRead),
                    cacheCreation: formatCompact(p.cacheCreation),
                  })}
                >
                  {formatCompact(p.input + p.output + p.cacheRead + p.cacheCreation)}
                </td>
                <td>
                  <div className="flex items-center gap-2" title={p.unpriced ? t('stats.projects.unpriced') : undefined}>
                    <div className="bar-track flex-1">
                      <div className="bar-fill" style={{ width: `${Math.max(p.cost > 0 ? 1.5 : 0, (p.cost / max) * 100)}%` }} />
                    </div>
                    <span className="w-20 shrink-0 text-right tabular text-ink-1">
                      {formatUsd(p.cost)}
                      {p.unpriced && <span className="text-tone-amber">*</span>}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {priced.some((p) => p.unpriced) && <p className="text-[12.5px] text-ink-3">* {t('stats.projects.unpriced')}</p>}
    </section>
  )
}

function ToolUsagePanel({ tools }: { tools: ToolUsageRow[] }) {
  const { locale, t } = useI18n()
  const max = Math.max(1, ...tools.map((r) => r.calls))
  const pct = new Intl.NumberFormat(BCP47[locale], { style: 'percent', maximumFractionDigits: 1 })
  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div>
        <h2 className="section-title">{t('stats.tools.title')}</h2>
        <p className="section-desc">{t('stats.tools.desc')}</p>
      </div>
      {tools.map((r) => (
        <BarRow
          key={r.tool}
          label={r.tool}
          value={t('stats.tools.value', { calls: r.calls.toLocaleString(), rate: pct.format(r.errors / Math.max(1, r.calls)) })}
          fraction={r.calls / max}
        />
      ))}
      <p className="text-[12.5px] text-ink-3">{t('stats.tools.footnote')}</p>
    </section>
  )
}

function UsageBlocksPanel({ blocks }: { blocks: UsageBlock[] }) {
  const { locale, t } = useI18n()
  const bcp = BCP47[locale]
  const now = Date.now()
  const time = (ms: number) => new Date(ms).toLocaleTimeString(bcp, { hour: '2-digit', minute: '2-digit' })
  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div>
        <h2 className="section-title">{t('stats.blocks.title')}</h2>
        <p className="section-desc">{t('stats.blocks.desc')}</p>
      </div>
      {blocks.length === 0 ? (
        <p className="text-[13.5px] text-ink-3">{t('stats.blocks.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('stats.blocks.window')}</th>
                <th className="text-right">{t('stats.projects.responses')}</th>
                <th className="text-right">{t('stats.projects.tokens')}</th>
                <th className="text-right">{t('stats.tokens.cacheRead')}</th>
              </tr>
            </thead>
            <tbody>
              {[...blocks].reverse().map((b) => (
                <tr key={b.startMs}>
                  <td className="whitespace-nowrap">
                    <span className="tabular text-ink-1">
                      {new Date(b.startMs).toLocaleDateString(bcp, { month: 'short', day: 'numeric' })} {time(b.startMs)}–{time(b.endMs)}
                    </span>
                    {now >= b.startMs && now < b.endMs && <span className="badge tone-green ml-2">{t('stats.blocks.active')}</span>}
                  </td>
                  <td className="text-right tabular">{b.responses.toLocaleString()}</td>
                  <td
                    className="text-right tabular"
                    title={`${t('stats.tokens.input')} ${formatCompact(b.input)} · ${t('stats.tokens.output')} ${formatCompact(b.output)}`}
                  >
                    {formatCompact(b.input + b.output)}
                  </td>
                  <td className="text-right tabular">{formatCompact(b.cacheRead)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function StatsTab({ stats }: { stats: StatsPayload | null }) {
  const { t } = useI18n()
  const [prices, setPrices] = useState<ModelPrice[] | null>(null)

  useEffect(() => {
    let alive = true
    window.vault
      .pricesList()
      .then((p) => alive && setPrices(p))
      .catch(() => alive && setPrices([]))
    return () => {
      alive = false
    }
  }, [])

  const costs = useMemo(() => (stats && prices ? costRows(stats.tokensByModel, prices) : []), [stats, prices])
  const priced = costs.filter((r) => r.cost != null)
  const total = priced.reduce((sum, r) => sum + (r.cost ?? 0), 0)

  if (!stats) return <p className="empty">{t('common.loading')}</p>

  const days = stats.activityByDay.length
  const perDay = days ? Math.round(stats.totalPrompts / days) : 0
  const maxModel = Math.max(1, ...stats.tokensByModel.map((m) => m.input + m.output))
  const maxRole = Math.max(1, ...stats.messagesByRole.map((r) => r.count))
  const roleLabel: Record<string, string> = { user: t('role.me'), assistant: t('role.assistant'), tool: t('role.tool') }
  const models = stats.tokensByModel.filter((m) => m.input + m.output > 0)

  return (
    <div className="page">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={t('stats.prompts')}
          value={stats.totalPrompts.toLocaleString()}
          unit={t('unit.count')}
          foot={stats.activityFromTimestamps ? t('stats.prompts.perDay', { count: perDay }) : t('stats.prompts.foot')}
        />
        <StatTile
          label={t('stats.sessions')}
          value={stats.totalSessions.toLocaleString()}
          unit={t('unit.count')}
          foot={t('stats.sessions.foot', { projects: stats.totalProjects, archived: stats.archivedSessions })}
        />
        <StatTile
          label={t('stats.messages')}
          value={formatCompact(stats.totalMessages)}
          unit={t('unit.rows')}
          foot={t('stats.messages.foot')}
        />
        <StatTile
          label={t('cost.total')}
          value={prices ? formatUsd(total) : '…'}
          foot={costs.length - priced.length > 0 ? t('cost.unpriced', { count: costs.length - priced.length }) : t('cost.footnote')}
        />
      </div>

      {stats.activityByDay.length > 0 && <ActivityChart days={stats.activityByDay} />}

      {stats.activityYear.length > 0 && <YearHeatmap days={stats.activityYear} />}

      {stats.activityByHour.length > 0 && <HourHeatmap cells={stats.activityByHour} />}

      <OpenDaysPanel days={stats.appOpenDays} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="glass panel flex flex-col gap-4 p-5">
          <div>
            <h2 className="section-title">{t('stats.byModel')}</h2>
            <p className="section-desc">{t('stats.byModel.desc')}</p>
          </div>
          {models.length === 0 && <p className="text-[13.5px] text-ink-3">{t('stats.tokens.empty')}</p>}
          {models.map((m) => (
            <BarRow
              key={m.model}
              label={m.model}
              value={t('stats.byModel.turns', { turns: m.messages.toLocaleString(), tokens: formatCompact(m.input + m.output) })}
              fraction={(m.input + m.output) / maxModel}
            />
          ))}
        </section>
        <section className="glass panel flex flex-col gap-4 p-5">
          <div>
            <h2 className="section-title">{t('stats.byRole')}</h2>
            <p className="section-desc">{t('stats.byRole.desc')}</p>
          </div>
          {stats.messagesByRole.map((r) => (
            <BarRow
              key={r.role}
              label={roleLabel[r.role] ?? r.role}
              value={r.count.toLocaleString()}
              fraction={r.count / maxRole}
            />
          ))}
        </section>
      </div>

      <section className="glass panel flex flex-col gap-4 p-5">
        <div>
          <h2 className="section-title">{t('stats.tokens')}</h2>
          <p className="section-desc">{t('stats.tokens.desc')}</p>
        </div>
        {stats.tokenTotals.input + stats.tokenTotals.output === 0 ? (
          <p className="text-[13.5px] text-ink-3">{t('stats.tokens.empty')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
            {(
              [
                [t('stats.tokens.input'), stats.tokenTotals.input],
                [t('stats.tokens.output'), stats.tokenTotals.output],
                [t('stats.tokens.cacheRead'), stats.tokenTotals.cacheRead],
                [t('stats.tokens.cacheCreation'), stats.tokenTotals.cacheCreation],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <div className="text-[28px] font-light leading-tight tracking-[-0.04em] text-ink-1">{formatCompact(value)}</div>
                <div className="text-[12.5px] text-ink-3">
                  {label} {t('stats.tokens.suffix')}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {prices && stats.tokensByModel.length > 0 && (
        <CostPanel costs={costs} total={total} prices={prices} onPrices={setPrices} />
      )}

      {prices && stats.tokensByProject.length > 0 && <ProjectUsagePanel rows={stats.tokensByProject} prices={prices} />}

      {(stats.toolUsage.length > 0 || stats.usageBlocks.length > 0) && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {stats.toolUsage.length > 0 && <ToolUsagePanel tools={stats.toolUsage} />}
          <UsageBlocksPanel blocks={stats.usageBlocks} />
        </div>
      )}

      {stats.topTokens.length > 0 && (
        <section className="glass panel flex flex-col gap-3 p-5">
          <div>
            <h2 className="section-title">{t('stats.topWords')}</h2>
            <p className="section-desc">{t('stats.topWords.desc')}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {stats.topTokens.map((tok) => (
              <span key={tok.token} className="rounded-full bg-well px-2.5 py-1 text-[13px] text-ink-1">
                {tok.token} <span className="text-ink-3 tabular">{tok.count.toLocaleString()}</span>
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * Estimated spend from the token counts already in the index.
 *
 * Two deliberate choices: models with no price row are *excluded* from the total
 * and called out by name (a silent 0 would read as "this was free"), and the price
 * table is editable inline because published rates move and a baked-in number would
 * quietly drift wrong.
 */
function CostPanel({
  costs,
  total,
  prices,
  onPrices,
}: {
  costs: CostRow[]
  total: number
  prices: ModelPrice[]
  onPrices: (p: ModelPrice[]) => void
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ModelPrice[]>([])
  const [newModel, setNewModel] = useState('')

  const priced = costs.filter((r) => r.cost != null)
  const unpricedModels = costs.filter((r) => r.cost == null).map((r) => r.model)
  const max = Math.max(1e-9, ...priced.map((r) => r.cost ?? 0))

  const startEdit = () => {
    setDraft(prices.map((p) => ({ ...p })))
    setEditing(true)
  }

  const commit = async () => {
    onPrices(await window.vault.pricesSave(draft))
    setEditing(false)
  }

  const patch = (i: number, field: keyof ModelPrice, value: string) => {
    setDraft((d) => d.map((p, idx) => (idx === i ? { ...p, [field]: field === 'model' ? value : Number(value) } : p)))
  }

  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div className="section-head">
        <div>
          <h2 className="section-title">{t('cost.title')}</h2>
          <p className="section-desc">{t('cost.disclaimer')}</p>
        </div>
        <button type="button" className={GHOST_BTN} onClick={() => (editing ? void commit() : startEdit())}>
          {editing ? t('cost.donePrices') : t('cost.editPrices')}
        </button>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="stat-value">{formatUsd(total)}</span>
        {unpricedModels.length > 0 && (
          <span className="badge tone-amber" title={t('cost.unpriced.hint')}>
            {unpricedModels.length === 1 ? t('cost.unpriced.one') : t('cost.unpriced', { count: unpricedModels.length })}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {priced.map((r) => (
          <BarRow key={r.model} label={r.model} value={formatUsd(r.cost ?? 0)} fraction={(r.cost ?? 0) / max} />
        ))}
      </div>

      {unpricedModels.length > 0 && (
        <p className="alert tone-amber break-words">
          {t('cost.unpriced.models', { models: unpricedModels.join(', ') })}
        </p>
      )}

      {editing && (
        <div className="flex flex-col gap-3 rounded-2xl bg-well p-4">
          <div>
            <h3 className="text-[14px] font-semibold text-ink-1">{t('cost.prices.title')}</h3>
            <p className="text-[12.5px] text-ink-3">{t('cost.prices.note', { date: PRICES_AS_OF, openaiDate: OPENAI_PRICES_AS_OF })}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="table min-w-[680px]">
              <thead>
                <tr>
                  <th>{t('cost.prices.model')}</th>
                  <th>{t('cost.prices.input')}</th>
                  <th>{t('cost.prices.output')}</th>
                  <th>{t('cost.prices.cacheRead')}</th>
                  <th>{t('cost.prices.cacheWrite')}</th>
                  <th>{t('cost.prices.cacheWrite1h')}</th>
                </tr>
              </thead>
              <tbody>
                {draft.map((p, i) => (
                  <tr key={p.model}>
                    <td className="mono text-ink-1">{p.model}</td>
                    {(['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok', 'cacheWrite1hPerMTok'] as const).map(
                      (field) => (
                        <td key={field}>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={p[field]}
                            onChange={(e) => patch(i, field, e.target.value)}
                            aria-label={`${p.model} ${field}`}
                            className="input tabular w-24 !px-2 !py-1"
                          />
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder={t('cost.prices.addPlaceholder')}
              aria-label={t('cost.prices.addPlaceholder')}
              className="input mono w-64"
            />
            <button
              type="button"
              className={GHOST_BTN}
              disabled={!newModel.trim() || draft.some((p) => p.model === newModel.trim())}
              onClick={() => {
                setDraft((d) => [
                  ...d,
                  {
                    model: newModel.trim(),
                    inputPerMTok: 0,
                    outputPerMTok: 0,
                    cacheReadPerMTok: 0,
                    cacheWritePerMTok: 0,
                    cacheWrite1hPerMTok: 0,
                  },
                ])
                setNewModel('')
              }}
            >
              {t('cost.prices.add')}
            </button>
            <button
              type="button"
              className={`${GHOST_BTN} ml-auto`}
              onClick={async () => {
                const restored = await window.vault.pricesReset()
                onPrices(restored)
                setDraft(restored.map((p) => ({ ...p })))
              }}
            >
              {t('cost.prices.reset')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

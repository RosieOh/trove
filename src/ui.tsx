import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { ProjectRow } from '../shared/ipc'
import { useT } from './i18n'

/** 사이드바·목록: 경로 꼬리만 짧게 (전체는 title 툴팁). */
export function sidebarPrimaryLabel(displayName: string): string {
  const parts = displayName.split(/[/\\]/u).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
  }
  return parts[parts.length - 1] ?? displayName
}

const ICONS = {
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35',
  sessions: 'M4 6h16M4 12h16M4 18h10m4 0h2',
  prompt: 'M4 5h16v11H8l-4 4V5Zm4 4h8m-8 3h5',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5',
  star: 'm12 3 2.9 5.9 6.1.9-4.5 4.3 1.1 6.4L12 17.5 6.4 20.5l1.1-6.4L3 9.8l6.1-.9L12 3Z',
  template: 'M5 3h9l5 5v13H5V3Zm9 0v5h5M8 13h8M8 17h5',
  chart: 'M4 20V10m5 10V4m5 16v-7m5 7V8',
  export: 'M12 15V3m0 0L8 7m4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.4 7.4 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-14v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  refresh: 'M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4m-4 5a8 8 0 0 0 14.9 3.9M20 20v-4h-4',
  chevron: 'm6 9 6 6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  filter: 'M4 6h16M7 12h10m-7 6h4',
  vault: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm7 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 0V7m0 10v-2',
} as const

export type TabIcon = keyof typeof ICONS

/** 1.75px stroke icons — one family across the shell. */
export function Icon({ name, className = '' }: { name: TabIcon; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 shrink-0 ${className}`}
    >
      <path d={ICONS[name]} />
    </svg>
  )
}

/** Pill segmented control. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: readonly (readonly [T, string])[]
  disabled?: boolean
  label?: string
}) {
  return (
    <div className="seg shrink-0" role="group" aria-label={label} aria-disabled={disabled || undefined}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className="seg-item" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** Labelled group inside a settings/filter panel. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  )
}

/** Quiet secondary action — one shape for every non-primary row action. */
export const GHOST_BTN = 'btn btn-tertiary btn-xs'

/** The lit space behind the glass. Static: see the note on `.orb` in index.css. */
export function World() {
  return (
    <div className="world" aria-hidden>
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
      <div className="floor" />
    </div>
  )
}

export type RailItem<K extends string> = { key: K; label: string; icon: TabIcon }

const RAIL_STEP = 48 // 40px button + 8px gap

/**
 * Floating icon rail. A glass droplet marks the current screen and slides to the item
 * under the pointer; labels appear as tooltips.
 */
export function Rail<K extends string>({
  items,
  active,
  onSelect,
  footer,
  brandLabel,
}: {
  items: RailItem<K>[]
  active: K
  onSelect: (k: K) => void
  footer: ReactNode
  brandLabel: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  // -1 when the active screen lives in the footer (settings): no droplet in the list.
  const activeIndex = items.findIndex((it) => it.key === active)
  const blobIndex = hover ?? activeIndex
  return (
    <aside className="rail glass" aria-label={brandLabel}>
      <div className="flex flex-col items-center gap-5">
        <span className="brand-mark" title="Trove" aria-hidden>
          <Icon name="vault" className="h-[18px] w-[18px]" />
        </span>
        <ul className="rail-list" onMouseLeave={() => setHover(null)}>
          <span
            className="rail-blob"
            style={{ transform: `translateY(${Math.max(0, blobIndex) * RAIL_STEP}px)`, opacity: blobIndex < 0 ? 0 : 1 }}
            aria-hidden
          />
          {items.map((it, i) => (
            <li key={it.key}>
              <button
                type="button"
                className="rail-link"
                aria-label={it.label}
                aria-current={it.key === active ? 'page' : undefined}
                onClick={() => onSelect(it.key)}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <Icon name={it.icon} />
                <span className="tip">{it.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col items-center gap-2">{footer}</div>
    </aside>
  )
}

/** A rail button outside the main list (theme, settings…). */
export function RailButton({
  icon,
  label,
  onClick,
  current,
  children,
}: {
  icon?: TabIcon
  label: string
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  current?: boolean
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      className="rail-link"
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      {children ?? (icon ? <Icon name={icon} /> : null)}
      <span className="tip">{label}</span>
    </button>
  )
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="min-w-0">
        <h1 className="page-title truncate">{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </header>
  )
}

/** Transient confirmation at the bottom of the window; replaces the old status bar. */
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDone, 3200)
    return () => clearTimeout(timer)
  }, [message, onDone])
  if (!message) return null
  return (
    <div key={message} className="toast glass-solid" role="status" aria-live="polite">
      <span className="dot tone-blue" aria-hidden />
      <span className="truncate">{message}</span>
    </div>
  )
}

/**
 * Turns FTS snippet markers («hit») into highlighted spans. The markers come from
 * `snippet(...)` in search SQL; anything else renders as plain text.
 */
export function Snippet({ text, className = '' }: { text: string; className?: string }) {
  const parts = text.split(/[«»]/)
  return (
    <span className={className}>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </span>
  )
}

export function RoleBadge({ role }: { role: string }) {
  const t = useT()
  if (role === 'user') return <span className="badge tone-blue">{t('role.badge.user')}</span>
  if (role === 'assistant') return <span className="badge tone-violet">{t('role.badge.assistant')}</span>
  if (role === 'tool') return <span className="badge tone-gray">{t('role.badge.tool')}</span>
  return <span className="badge tone-gray">{role}</span>
}

/** Close a popover on outside click or Escape. */
function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open, onClose])
  return ref
}

/**
 * Project filter as a pill + searchable menu. With dozens of projects a permanent
 * sidebar list ate a third of the width; this keeps the filter one click away.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: ProjectRow[]
  value: number | undefined
  onChange: (id: number | undefined) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const close = () => {
    setOpen(false)
    setQ('')
  }
  const ref = useDismiss(open, close)
  const current = projects.find((p) => p.id === value)
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? projects.filter((p) => p.displayName.toLowerCase().includes(s)) : projects
  }, [projects, q])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`btn ${value != null ? 'btn-secondary' : 'btn-tertiary'} max-w-[16rem]`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={current?.displayName}
      >
        <Icon name="folder" />
        <span className="truncate">{current ? sidebarPrimaryLabel(current.displayName) : t('nav.projects.all')}</span>
        <Icon name="chevron" className="h-3.5 w-3.5 opacity-70" />
      </button>
      {open && (
        <div className="menu right-0 top-[calc(100%+6px)] flex max-h-[min(70vh,32rem)] w-80 flex-col">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('projects.find')}
            aria-label={t('projects.find')}
            className="input mb-1 w-full"
          />
          <div className="min-h-0 overflow-y-auto" role="listbox" aria-label={t('nav.projects')}>
            <button
              type="button"
              role="option"
              aria-selected={value == null}
              className="menu-item"
              onClick={() => {
                onChange(undefined)
                close()
              }}
            >
              <span className="min-w-0 flex-1 truncate">{t('nav.projects.all')}</span>
              <span className="tabular text-[12px] text-ink-3">{projects.length}</span>
            </button>
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={value === p.id}
                className="menu-item"
                title={`${p.displayName}\n${p.path}`}
                onClick={() => {
                  onChange(p.id)
                  close()
                }}
              >
                <span className="min-w-0 flex-1 truncate">{sidebarPrimaryLabel(p.displayName)}</span>
                {p.tool !== 'claude' && <span className="badge tone-orange">{p.tool}</span>}
                {(p.archived || p.archivedCount > 0) && (
                  <span className="badge tone-amber" title={t('badge.archived.hint')}>
                    {p.archived ? t('badge.archived') : `${t('badge.archived')} ${p.archivedCount}`}
                  </span>
                )}
                <span className="tabular text-[12px] text-ink-3">{p.sessionCount}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Toggle the theme; where supported the new theme spreads as a circle from the button. */
export function toggleTheme(e: MouseEvent<HTMLElement>, onChange: (dark: boolean) => void) {
  const root = document.documentElement
  const apply = () => {
    const dark = root.classList.toggle('dark')
    try {
      localStorage.setItem('vault-theme', dark ? 'dark' : 'light')
    } catch {
      /* still switches for this window */
    }
    onChange(dark)
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const start = (document as Document & { startViewTransition?: (cb: () => void) => unknown }).startViewTransition
  if (!start || reduced) {
    apply()
    return
  }
  const r = e.currentTarget.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  root.style.setProperty('--vt-x', `${x}px`)
  root.style.setProperty('--vt-y', `${y}px`)
  root.style.setProperty('--vt-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`)
  start.call(document, apply)
}

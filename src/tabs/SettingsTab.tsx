import { useCallback, useEffect, useState } from 'react'
import {
  BACKUP_KEEP_CHOICES,
  GLOBAL_SHORTCUT_CHOICES,
  type BackupInfo,
  type BackupReason,
  type McpCommand,
  type SettingsInfo,
  type UpdateStatus,
} from '../../shared/ipc'
import { LOCALES, LOCALE_LABEL, type MessageKey } from '../../shared/i18n'
import { useI18n } from '../i18n'
import { formatTs } from '../format'
import { Segmented } from '../ui'

const IS_MAC = navigator.userAgent.includes('Mac')

/** `CommandOrControl+Shift+Space` → `⌘⇧Space` on macOS, `Ctrl+Shift+Space` elsewhere. */
function shortcutLabel(accel: string): string {
  const mac: Record<string, string> = { CommandOrControl: '⌘', Alt: '⌥', Shift: '⇧' }
  const other: Record<string, string> = { CommandOrControl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  const parts = accel.split('+').map((k) => (IS_MAC ? mac[k] : other[k]) ?? k)
  return IS_MAC ? parts.join('') : parts.join('+')
}

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`
  return `${n} B`
}

const UPDATE_STATE_KEY: Record<UpdateStatus['state'], MessageKey> = {
  idle: 'settings.update.state.idle',
  unsupported: 'settings.update.state.unsupported',
  disabled: 'settings.update.state.disabled',
  checking: 'settings.update.state.checking',
  downloading: 'settings.update.state.downloading',
  ready: 'settings.update.state.ready',
  error: 'settings.update.state.error',
}

const REASON_KEY: Record<BackupReason, MessageKey> = {
  daily: 'settings.backup.reason.daily',
  manual: 'settings.backup.reason.manual',
  'pre-migration': 'settings.backup.reason.pre-migration',
  'pre-purge': 'settings.backup.reason.pre-purge',
  'pre-restore': 'settings.backup.reason.pre-restore',
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="glass panel flex flex-col gap-4 p-5">
      <div>
        <h2 className="section-title">{title}</h2>
        {desc ? <p className="section-desc mt-1 leading-relaxed">{desc}</p> : null}
      </div>
      {children}
    </section>
  )
}

/**
 * Snapshots of the vault DB. Restoring swaps the file and relaunches the app, so the
 * button asks for a second click like the other irreversible-looking actions.
 */
function BackupSection({ onStatus, refreshKey }: { onStatus: (s: string) => void; refreshKey: number }) {
  const { locale, t } = useI18n()
  const [info, setInfo] = useState<BackupInfo | null>(null)
  const [running, setRunning] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)

  const load = useCallback(async () => setInfo(await window.vault.backupsList()), [])
  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    if (!confirm) return
    const timer = setTimeout(() => setConfirm(null), 4000)
    return () => clearTimeout(timer)
  }, [confirm])

  if (!info) return null

  const backUpNow = async () => {
    setRunning(true)
    try {
      const r = await window.vault.backupCreate()
      if (r.ok) onStatus(t('toast.backup.done', { size: formatBytes(r.file.sizeBytes) }))
      else if (r.error === 'disk') onStatus(t('toast.backup.disk'))
      else onStatus(t('toast.backup.failed', { message: r.message ?? '' }))
    } finally {
      setRunning(false)
      await load()
    }
  }

  const restore = async (name: string) => {
    if (confirm !== name) {
      setConfirm(name)
      return
    }
    setConfirm(null)
    // On success the app relaunches and this never resolves.
    const r = await window.vault.backupRestore(name)
    onStatus(t('toast.restore.failed', { message: r.message ?? r.error }))
    await load()
  }

  return (
    <Section title={t('settings.backup.title')} desc={t('settings.backup.help')}>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label={t('settings.backup.keep')}
          value={String(info.keep)}
          onChange={async (v) => {
            await window.vault.settingsSet({ backupKeep: Number(v) })
            await load()
          }}
          options={BACKUP_KEEP_CHOICES.map((n) => [String(n), n === 0 ? t('settings.off') : String(n)] as const)}
        />
        <button type="button" className="btn btn-tertiary btn-xs" disabled={running} onClick={() => void backUpNow()}>
          {running ? t('settings.backup.running') : t('settings.backup.now')}
        </button>
        <button type="button" className="btn btn-tertiary btn-xs" onClick={() => void window.vault.backupsReveal()}>
          {t('settings.backup.reveal')}
        </button>
        {info.items.length > 0 && (
          <span className="text-[13px] text-ink-3 tabular">
            {t('settings.backup.total', { count: info.items.length, size: formatBytes(info.totalBytes) })}
          </span>
        )}
      </div>
      {info.keep === 0 && <p className="alert tone-amber">{t('settings.backup.offNote')}</p>}
      {info.items.length === 0 ? (
        <p className="text-[13px] text-ink-3">{t('settings.backup.empty')}</p>
      ) : (
        <div className="flex flex-col">
          {info.items.map((b) => (
            <div key={b.name} className="row flex items-center gap-3" data-active={confirm === b.name || undefined}>
              <div className="row-meta flex-1">
                <span className="tabular text-ink-1">{formatTs(b.createdAt, locale)}</span>
                <span className="badge tone-gray">{t(REASON_KEY[b.reason])}</span>
                <span className="tabular">{formatBytes(b.sizeBytes)}</span>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className={`btn btn-xs ${confirm === b.name ? 'btn-danger' : 'btn-tertiary'}`}
                  onClick={() => void restore(b.name)}
                >
                  {confirm === b.name ? t('settings.backup.restoreConfirm') : t('settings.backup.restore')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {info.items.length > 0 && <p className="text-[12.5px] text-ink-3">{t('settings.backup.restoreNote')}</p>}
    </Section>
  )
}

/** The `claude mcp add` line that registers Trove's read-only MCP server (ADR-0011). */
function McpSection({ onStatus }: { onStatus: (s: string) => void }) {
  const { t } = useI18n()
  const [cmd, setCmd] = useState<McpCommand | null>(null)
  useEffect(() => {
    void window.vault.mcpCommand().then(setCmd)
  }, [])
  return (
    <Section title={t('settings.mcp.title')} desc={t('settings.mcp.help')}>
      {cmd && (
        <div className="flex flex-col gap-3">
          <code className="alert tone-gray mono select-all break-all !text-[12.5px] text-ink-1">
            {cmd.claudeAddLine}
          </code>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-tertiary btn-xs"
              onClick={async () => {
                await window.vault.copyText(cmd.claudeAddLine)
                onStatus(t('settings.mcp.copied'))
              }}
            >
              {t('settings.mcp.copy')}
            </button>
            <span className="text-[12.5px] text-ink-3">{t('settings.mcp.note')}</span>
          </div>
        </div>
      )}
    </Section>
  )
}

/**
 * Everything the user may want to decide about their data: what happens when Claude
 * Code deletes transcripts, whether the app may make its one network request, and
 * where the index lives.
 */
export function SettingsTab({
  update,
  archivedSessions,
  onStatus,
  onChanged,
}: {
  update: UpdateStatus
  archivedSessions: number
  onStatus: (s: string) => void
  onChanged: () => void
}) {
  const { locale, setLocale, t } = useI18n()
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [confirmPurge, setConfirmPurge] = useState(false)
  const [reparsing, setReparsing] = useState(false)
  // A purge takes a backup first; bump this so the backup list shows it.
  const [backupsVersion, setBackupsVersion] = useState(0)

  const load = useCallback(async () => setInfo(await window.vault.settingsGet()), [])
  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!confirmPurge) return
    const timer = setTimeout(() => setConfirmPurge(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmPurge])

  if (!info) return <p className="empty">{t('common.loading')}</p>

  const set = async (patch: Partial<SettingsInfo>) => {
    await window.vault.settingsSet(patch)
    await load()
  }

  return (
    <div className="page">
      <div className="grid max-w-4xl gap-4">
        <Section title={t('settings.archive.title')} desc={t('settings.archive.help')}>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label={t('settings.archive.title')}
              value={info.archiveMode}
              onChange={(v) => void set({ archiveMode: v })}
              options={
                [
                  ['keep', t('settings.archive.keep')],
                  ['mirror', t('settings.archive.mirror')],
                ] as const
              }
            />
            <span className="text-[13px] text-ink-3 tabular">
              {t('settings.archive.count', { sessions: archivedSessions, plans: info.archivedPlans })}
            </span>
            {archivedSessions + info.archivedPlans > 0 && (
              <button
                type="button"
                className={`btn btn-xs ${confirmPurge ? 'btn-danger' : 'btn-tertiary'}`}
                onClick={async () => {
                  if (!confirmPurge) {
                    setConfirmPurge(true)
                    return
                  }
                  setConfirmPurge(false)
                  try {
                    const n = await window.vault.archivePurge()
                    onStatus(t('toast.purged', { count: n }))
                    onChanged()
                  } catch {
                    onStatus(t('toast.purge.backupFailed'))
                  }
                  setBackupsVersion((v) => v + 1)
                  await load()
                }}
              >
                {confirmPurge
                  ? t(info.backupKeep > 0 ? 'settings.archive.purgeConfirmBackup' : 'settings.archive.purgeConfirm')
                  : t('settings.archive.purge')}
              </button>
            )}
          </div>
          {info.archiveMode === 'mirror' && <p className="alert tone-amber">{t('settings.archive.mirrorNote')}</p>}
        </Section>

        <BackupSection onStatus={onStatus} refreshKey={backupsVersion} />

        <Section title={t('settings.privacy.title')} desc={t('settings.privacy.help')}>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label={t('settings.privacy.title')}
              value={info.maskSecrets ? 'on' : 'off'}
              onChange={(v) => void set({ maskSecrets: v === 'on' })}
              options={
                [
                  ['on', t('settings.on')],
                  ['off', t('settings.off')],
                ] as const
              }
            />
          </div>
          {!info.maskSecrets && <p className="alert tone-amber">{t('settings.privacy.offNote')}</p>}
        </Section>

        <Section title={t('settings.shortcut.title')} desc={t('settings.shortcut.help')}>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
            label={t('settings.shortcut.title')}
            value={info.globalShortcut}
            onChange={async (v) => {
              const next = await window.vault.settingsSet({ globalShortcut: v })
              if (next.globalShortcut !== v) onStatus(t('settings.shortcut.taken'))
              await load()
            }}
            options={GLOBAL_SHORTCUT_CHOICES.map((c) => [c, c ? shortcutLabel(c) : t('settings.off')] as const)}
          />
          </div>
        </Section>

        <Section title={t('settings.notify.title')} desc={t('settings.notify.help')}>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
            label={t('settings.notify.title')}
            value={info.archiveNotify ? 'on' : 'off'}
            onChange={(v) => void set({ archiveNotify: v === 'on' })}
            options={
              [
                ['on', t('settings.on')],
                ['off', t('settings.off')],
              ] as const
            }
          />
          </div>
        </Section>

        <Section title={t('settings.update.title')} desc={t('settings.update.help')}>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label={t('settings.update.title')}
              value={info.autoUpdate ? 'on' : 'off'}
              onChange={(v) => void set({ autoUpdate: v === 'on' })}
              options={
                [
                  ['on', t('settings.on')],
                  ['off', t('settings.off')],
                ] as const
              }
            />
            <button
              type="button"
              className="btn btn-tertiary btn-xs"
              disabled={!info.autoUpdate || update.state === 'unsupported' || update.state === 'checking'}
              onClick={() => void window.vault.updateCheck()}
            >
              {t('settings.update.check')}
            </button>
            <span className="text-[13px] text-ink-3">
              {t(UPDATE_STATE_KEY[update.state], {
                percent: update.percent ?? 0,
                version: update.version ?? '',
                message: update.message ?? '',
              })}
            </span>
          </div>
        </Section>

        <McpSection onStatus={onStatus} />

        <Section title={t('settings.language.title')}>
          <Segmented
            label={t('settings.language.title')}
            value={locale}
            onChange={setLocale}
            options={LOCALES.map((l) => [l, LOCALE_LABEL[l]] as const)}
          />
        </Section>

        <Section title={t('settings.data.title')} desc={t('settings.data.reparseHelp')}>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13.5px]">
            <dt className="text-ink-3">{t('settings.data.db')}</dt>
            <dd className="mono break-all !text-[12.5px] text-ink-1">
              {info.dbPath} · {formatBytes(info.dbSizeBytes)}
            </dd>
            <dt className="text-ink-3">{t('settings.data.source')}</dt>
            <dd className="mono break-all !text-[12.5px] text-ink-1">{info.claudeHome}</dd>
          </dl>
          <div>
            <button
              type="button"
              className="btn btn-tertiary"
              disabled={reparsing}
              onClick={async () => {
                setReparsing(true)
                try {
                  const r = await window.vault.reindex(true)
                  onStatus(t('toast.reindexed', { projects: r.projects, sessions: r.sessions, plans: r.planFiles }))
                  onChanged()
                } finally {
                  setReparsing(false)
                  await load()
                }
              }}
            >
              {reparsing ? t('settings.data.reparsing') : t('settings.data.reparse')}
            </button>
          </div>
        </Section>
      </div>
    </div>
  )
}

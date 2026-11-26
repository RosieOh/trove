/**
 * Commands that reopen a session in its tool. Trove never runs them: the user copies
 * the line into a terminal. Claude Code names a session file `{uuid}.jsonl` and puts a
 * subagent's file under `{uuid}/subagents/`, so the parent uuid is the first path part.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** The Claude Code session id a transcript path belongs to (its parent's for a subagent). */
export function claudeSessionIdOf(relPath: string): string | null {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  for (const part of parts) {
    const base = part.replace(/\.jsonl$/i, '')
    if (/^[0-9a-f-]{36}$/i.test(base) && UUID.test(base)) return base
  }
  return null
}

/** Codex rollout files end in the session uuid: `rollout-2026-…-{uuid}.jsonl`. */
export function codexSessionIdOf(relPath: string): string | null {
  const base = relPath.split(/[\\/]/).pop() ?? ''
  const all = base.match(new RegExp(UUID.source, 'gi'))
  return all ? all[all.length - 1] : null
}

/** True for a subagent transcript (a part of a session, not one a person opened). */
export function isSubagentPath(relPath: string): boolean {
  return /(^|[\\/])subagents[\\/]/.test(relPath)
}

/** POSIX single-quote, safe for any path. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export type ResumeTarget = { tool: string; relPath: string; cwd: string | null }

/**
 * `cd <cwd> && claude --resume <id>`, or null when the id can't be known. Claude Code
 * looks a session up by the directory it was started in, hence the `cd`.
 */
export function resumeCommand(t: ResumeTarget, platform: string = 'darwin'): string | null {
  const id = t.tool === 'codex' ? codexSessionIdOf(t.relPath) : claudeSessionIdOf(t.relPath)
  if (!id) return null
  const run = t.tool === 'codex' ? `codex resume ${id}` : `claude --resume ${id}`
  if (!t.cwd) return run
  if (platform === 'win32') return `cd /d "${t.cwd.replace(/"/g, '')}" && ${run}`
  return `cd ${shellQuote(t.cwd)} && ${run}`
}

/** `claude --resume <id> --fork-session`: continue in a new session, leaving the original as it was. */
export function forkCommand(t: ResumeTarget, platform: string = 'darwin'): string | null {
  if (t.tool !== 'claude') return null
  const cmd = resumeCommand(t, platform)
  return cmd ? `${cmd} --fork-session` : null
}

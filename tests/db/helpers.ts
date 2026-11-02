import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach } from 'vitest'
import { openVaultDb, type DbHandle } from '../../electron/db'
import { upsertProject } from '../../electron/indexer'
import type { ToolAdapter } from '../../electron/adapters'
import { parseJsonlLine } from '../../shared/jsonlParse'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** A throwaway directory holding a fake Claude projects root and a vault DB. */
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'))
  const projectsRoot = path.join(dir, 'projects')
  const projectRoot = path.join(projectsRoot, '-work-app')
  fs.mkdirSync(projectRoot, { recursive: true })
  const dbFile = path.join(dir, 'vault.db')
  const handles: DbHandle[] = []
  cleanups.push(() => {
    for (const h of handles) {
      try {
        h.close()
      } catch {
        /* already closed */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const open = () => {
    const db = openVaultDb(dbFile)
    handles.push(db)
    return db
  }
  const adapter: ToolAdapter = {
    id: 'claude',
    label: 'test',
    root: projectsRoot,
    isAvailable: () => fs.existsSync(projectsRoot),
    listProjects: () => [{ slug: '-work-app', root: projectRoot, displayName: '/work/app' }],
    listSessions: () => fs.readdirSync(projectRoot).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(projectRoot, f)),
    projectForFile: () => ({ slug: '-work-app', root: projectRoot, displayName: '/work/app' }),
    createParser: () => parseJsonlLine,
    appendable: true,
  }
  const project = (db: DbHandle) =>
    upsertProject(db, { slug: '-work-app', root: projectRoot, displayName: '/work/app' }, 'claude')
  return { dir, projectsRoot, projectRoot, dbFile, open, adapter, project }
}

/** A DB as that version shipped, from its schema in `tests/db/fixtures`. The caller closes it. */
export function createShippedDb(dbFile: string, version: 9 | 10): DbHandle {
  const db = new Database(dbFile)
  db.exec(fs.readFileSync(fileURLToPath(new URL(`./fixtures/schema-v${version}.sql`, import.meta.url)), 'utf8'))
  db.prepare(`INSERT INTO meta VALUES ('schema_version', ?)`).run(String(version))
  return db
}

/**
 * Leaves a current DB with a step still to run. 0011 is the one step safe to run twice, so
 * this stays true as migrations are added: a later step would fail on tables it already made.
 */
export function markStepPending(db: DbHandle) {
  db.prepare(`DELETE FROM schema_migrations WHERE id = 11`).run()
}

export const userLine = (uuid: string, text: string, ts = '2026-10-01T10:00:00.000Z') =>
  JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } })

/** One content block of an API response; Claude Code writes several per response. */
export const assistantLine = (
  uuid: string,
  text: string,
  opts: { msgId?: string; requestId?: string; output?: number; model?: string } = {},
) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    requestId: opts.requestId ?? 'req_1',
    timestamp: '2026-10-01T10:00:05.000Z',
    message: {
      id: opts.msgId ?? 'msg_1',
      role: 'assistant',
      model: opts.model ?? 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 10,
        output_tokens: opts.output ?? 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 30 },
      },
    },
  })

export const toolResultLine = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
  })

export const metaLine = (text: string) => JSON.stringify({ type: 'ai-title', aiTitle: text })

export function writeLines(file: string, lines: string[]) {
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
}

export function appendLines(file: string, lines: string[]) {
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''))
  // mtime granularity: make sure the change is visible to the mtime check.
  const t = new Date(Date.now() + 2000)
  fs.utimesSync(file, t, t)
}

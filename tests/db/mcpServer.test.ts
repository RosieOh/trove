import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openVaultDb } from '../../electron/db'
import { indexSessionFile, reconcileMissing } from '../../electron/indexer'
import { handleRequest } from '../../electron/mcpServer'
import { assistantLine, sandbox, userLine, writeLines } from './helpers'

const repoRoot = path.resolve(__dirname, '..', '..')

const editLine = (uuid: string, filePath: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-10-01T10:01:00.000Z',
    message: {
      id: 'msg_edit',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: filePath, old_string: 'a', new_string: 'b' } }],
    },
  })

/** A vault with one live and one archived session, opened the way the MCP server opens it. */
async function vault() {
  const sb = sandbox()
  const db = sb.open()
  const pid = sb.project(db)
  const live = path.join(sb.projectRoot, 'live-0000-1111.jsonl')
  const gone = path.join(sb.projectRoot, 'gone-2222-3333.jsonl')
  writeLines(live, [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Key rotation plan' }),
    userLine('u1', 'how do we rotate the signing keys?'),
    assistantLine('a1', 'Rotate them with the keyring script. Old value: API_TOKEN=abcdef123456'),
    editLine('e1', '/work/app/src/keyring.ts'),
  ])
  writeLines(gone, [userLine('u2', 'old talk about the zebra migration', '2026-09-01T10:00:00.000Z')])
  for (const f of [live, gone]) await indexSessionFile(db, { projectId: pid, projectRoot: sb.projectRoot, filePath: f })
  fs.rmSync(gone)
  reconcileMissing(db, sb.adapter, 'keep')
  db.close()

  const ro = openVaultDb(sb.dbFile, { migrate: false })
  ro.pragma('query_only = ON')
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const res = handleRequest(ro, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    return { text: res.result.content[0].text, isError: res.result.isError === true }
  }
  return { sb, ro, call }
}

describe('MCP tools over a read-only vault', () => {
  it('search_history finds archived sessions and filters by project substring', async () => {
    const { call, ro } = await vault()
    const hit = call('search_history', { query: 'zebra' })
    expect(hit.isError).toBe(false)
    expect(hit.text).toContain('/work/app')
    expect(hit.text).toContain('[archived]')
    expect(call('search_history', { query: 'zebra', project: 'WORK/APP' }).text).toContain('zebra')
    expect(call('search_history', { query: 'zebra', project: 'nope' }).isError).toBe(true)
    expect(call('search_history', { query: 'keyring', role: 'user' }).text).toMatch(/^No messages/)
    ro.close()
  })

  it('get_session reads a transcript by id or file name and pages with from_line', async () => {
    const { call, ro } = await vault()
    const id = (ro.prepare(`SELECT id FROM sessions WHERE rel_path LIKE 'live%'`).get() as { id: number }).id
    const full = call('get_session', { session_id: id })
    expect(full.text).toContain('rotate the signing keys')
    expect(full.text).toContain('(tool)')
    const paged = call('get_session', { session_id: 'live-0000-1111', from_line: 2, max_messages: 1 })
    expect(paged.text).not.toContain('signing keys?')
    expect(paged.text).toContain('keyring script')
    expect(paged.text).toContain('from_line=3')
    expect(full.text).toContain('Title: Key rotation plan')
    expect(call('get_session', { session_id: 99999 }).text).toMatch(/^No session/)
    ro.close()
  })

  it('list_recent_sessions, list_prompts and file_history answer from the index', async () => {
    const { call, ro } = await vault()
    const recent = call('list_recent_sessions', { limit: 5 }).text
    expect(recent.split('\n').filter((l) => l.startsWith('session '))).toHaveLength(2)
    expect(call('list_prompts', { query: 'zebra' }).text).toContain('[archived]')
    const file = call('file_history', { path: 'keyring.ts' }).text
    expect(file).toContain('/work/app/src/keyring.ts')
    expect(file).toContain('1 session(s)')
    ro.close()
  })

  it('find_sessions lists sessions by title or prompt; session_context briefs one', async () => {
    const { call, ro } = await vault()
    const found = call('find_sessions', { query: 'rotation' }).text
    expect(found).toContain('Title: Key rotation plan')
    expect(found.split('\n').filter((l) => l.startsWith('session '))).toHaveLength(1)
    expect(call('find_sessions', { archived_only: true }).text).toContain('zebra')
    const brief = call('session_context', { session_id: 'live-0000-1111' }).text
    expect(brief).toContain('Title: Key rotation plan')
    expect(brief).toContain('1. how do we rotate the signing keys?')
    expect(brief).toContain('/work/app/src/keyring.ts')
    ro.close()
  })

  it('masks secrets in every tool result and filters search by date and archive state', async () => {
    const { call, ro } = await vault()
    const hit = call('search_history', { query: 'keyring', include_tools: true }).text
    expect(hit).not.toContain('abcdef123456')
    const session = call('get_session', { session_id: 'live-0000-1111' }).text
    expect(session).toContain('API_TOKEN=••••')
    expect(session).not.toContain('abcdef123456')
    expect(call('search_history', { query: 'zebra', archived_only: true }).text).toContain('zebra')
    expect(call('search_history', { query: 'zebra', after: '2026-09-15' }).text).toMatch(/^No messages/)
    expect(call('search_history', { query: 'zebra', before: '2026-09' }).text).toContain('zebra')
    expect(call('search_history', { query: 'zebra', after: 'yesterday' }).isError).toBe(true)
    ro.close()
  })

  it('cannot write through its connection', async () => {
    const { ro } = await vault()
    expect(() => ro.prepare(`DELETE FROM sessions`).run()).toThrow(/readonly|read-only|query_only/i)
    ro.close()
  })
})

/** Runs the real entry point over stdio (via tsx), as Claude Code would. */
function runServer(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const tsx = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
    const child = spawn(tsx, [path.join(repoRoot, 'electron', 'mcpServer.ts'), ...args], {
      cwd: repoRoot,
      shell: process.platform === 'win32',
      env: { ...process.env, TROVE_DB: '' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

describe('MCP server process', () => {
  it('speaks newline-delimited JSON-RPC on stdout and logs only to stderr', async () => {
    const { sb, ro } = await vault()
    ro.close()
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_history', arguments: { query: 'zebra' } } },
      { jsonrpc: '2.0', id: 3, method: 'nope' },
    ]
    const before = fs.statSync(sb.dbFile).mtimeMs
    const { code, stdout, stderr } = await runServer(['--db', sb.dbFile], lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    expect(code).toBe(0)
    const out = stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(out.map((o) => o.id)).toEqual([1, 2, 3])
    expect(out[0].result.protocolVersion).toBe('2025-06-18')
    expect(out[1].result.content[0].text).toContain('zebra')
    expect(out[2].error.code).toBe(-32601)
    expect(stderr).toContain('read-only')
    expect(fs.statSync(sb.dbFile).mtimeMs).toBe(before)
  })

  it('refuses to start, and creates nothing, when the DB is missing', async () => {
    const sb = sandbox()
    const missing = path.join(sb.dir, 'nowhere', 'vault.db')
    const { code, stdout, stderr } = await runServer(['--db', missing], '')
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('No Trove database')
    expect(fs.existsSync(path.dirname(missing))).toBe(false)
  })
})

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DbHandle } from '../electron/db'
import {
  clamp,
  defaultDbPath,
  handleRequest,
  mcpLaunch,
  PROTOCOL_VERSION,
  resolveDbPath,
  RPC_ERROR,
  TOOLS,
} from '../electron/mcpServer'

/** Protocol paths that never touch the DB. */
const noDb = {} as DbHandle
const req = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params })

describe('MCP JSON-RPC handling', () => {
  it('answers initialize with the protocol version, tool capability and server info', () => {
    const res = handleRequest(noDb, req('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} }), {
      name: 'trove',
      version: '9.9.9',
    })
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'trove', version: '9.9.9' } },
    })
  })

  it('offers its own version when the client asks for an unknown one', () => {
    const res = handleRequest(noDb, req('initialize', { protocolVersion: '1999-01-01' }))
    expect(res && 'result' in res && (res.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('sends nothing back for notifications', () => {
    expect(handleRequest(noDb, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(handleRequest(noDb, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).toBeNull()
  })

  it('answers ping with an empty result, keeping string ids', () => {
    expect(handleRequest(noDb, req('ping', undefined, 'abc'))).toEqual({ jsonrpc: '2.0', id: 'abc', result: {} })
  })

  it('lists the tools with object input schemas', () => {
    const res = handleRequest(noDb, req('tools/list'))
    const tools = (res as { result: { tools: typeof TOOLS } }).result.tools
    expect(tools.map((t) => t.name)).toEqual([
      'search_history',
      'find_sessions',
      'session_context',
      'get_session',
      'list_recent_sessions',
      'list_prompts',
      'file_history',
    ])
    for (const t of tools) expect(t.inputSchema.type).toBe('object')
  })

  it('returns JSON-RPC errors for unknown methods, unknown tools and malformed requests', () => {
    expect(handleRequest(noDb, req('resources/list'))).toMatchObject({ id: 1, error: { code: RPC_ERROR.methodNotFound } })
    expect(handleRequest(noDb, req('tools/call', { name: 'drop_everything' }))).toMatchObject({
      error: { code: RPC_ERROR.invalidParams },
    })
    expect(handleRequest(noDb, { id: 3, method: 'ping' })).toMatchObject({ id: 3, error: { code: RPC_ERROR.invalidRequest } })
    expect(handleRequest(noDb, [req('ping')])).toMatchObject({ id: null, error: { code: RPC_ERROR.invalidRequest } })
    expect(handleRequest(noDb, 'ping')).toMatchObject({ error: { code: RPC_ERROR.invalidRequest } })
  })

  it('reports a missing required argument as a tool error, not a protocol error', () => {
    const res = handleRequest(noDb, req('tools/call', { name: 'search_history', arguments: {} }))
    expect(res).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: '"query" is required' }] } })
  })
})

describe('MCP server paths and launch command', () => {
  it('defaults to the Trove userData folder on each platform', () => {
    expect(defaultDbPath('darwin', {}, '/Users/me')).toBe('/Users/me/Library/Application Support/Trove/vault.db')
    // Paths follow the target platform's rules whatever OS runs the test (CI runs all three).
    expect(defaultDbPath('linux', {}, '/home/me')).toBe('/home/me/.config/Trove/vault.db')
    expect(defaultDbPath('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/me')).toBe('/xdg/Trove/vault.db')
    expect(defaultDbPath('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Trove\\vault.db',
    )
    expect(defaultDbPath('win32', {}, 'C:\\Users\\me')).toBe('C:\\Users\\me\\AppData\\Roaming\\Trove\\vault.db')
  })

  it('takes --db over TROVE_DB over the default', () => {
    expect(resolveDbPath(['node', 's', '--db', '/a/v.db'], { TROVE_DB: '/b/v.db' })).toBe(path.resolve('/a/v.db'))
    expect(resolveDbPath(['node', 's', '--db=/c/v.db'], {})).toBe(path.resolve('/c/v.db'))
    expect(resolveDbPath(['node', 's'], { TROVE_DB: '/b/v.db' })).toBe(path.resolve('/b/v.db'))
  })

  it('runs the packaged app binary as Node and quotes paths with spaces', () => {
    const l = mcpLaunch({
      packaged: true,
      execPath: '/Applications/Trove.app/Contents/MacOS/Trove',
      appPath: '/Applications/Trove.app/Contents/Resources/app.asar',
      dbFile: '/Users/me/Library/Application Support/Trove/vault.db',
      platform: 'darwin',
    })
    expect(l.command).toBe('/Applications/Trove.app/Contents/MacOS/Trove')
    expect(l.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(l.args[0]).toBe('/Applications/Trove.app/Contents/Resources/app.asar/dist-electron/mcpServer.cjs')
    expect(l.claudeAddLine).toBe(
      "claude mcp add trove --scope user --env ELECTRON_RUN_AS_NODE=1 -- /Applications/Trove.app/Contents/MacOS/Trove /Applications/Trove.app/Contents/Resources/app.asar/dist-electron/mcpServer.cjs --db '/Users/me/Library/Application Support/Trove/vault.db'",
    )
  })

  it('builds Windows paths with backslashes on any host', () => {
    const l = mcpLaunch({
      packaged: true,
      execPath: 'C:\\Program Files\\Trove\\Trove.exe',
      appPath: 'C:\\Program Files\\Trove\\resources\\app.asar',
      dbFile: 'C:\\Users\\me\\AppData\\Roaming\\Trove\\vault.db',
      platform: 'win32',
    })
    expect(l.args[0]).toBe('C:\\Program Files\\Trove\\resources\\app.asar\\dist-electron\\mcpServer.cjs')
  })

  it('uses node and the repo build in development', () => {
    const l = mcpLaunch({ packaged: false, execPath: '/x/electron', appPath: '/repo', dbFile: '/tmp/v.db', platform: 'linux' })
    expect(l.command).toBe('node')
    expect(l.env).toEqual({})
    expect(l.claudeAddLine).toBe('claude mcp add trove --scope user -- node /repo/dist-electron/mcpServer.cjs --db /tmp/v.db')
  })

  it('clamps long bodies and says how much was cut', () => {
    expect(clamp('abc', 5)).toBe('abc')
    expect(clamp('abcdefgh', 5)).toBe('abcde… [+3 chars]')
  })
})

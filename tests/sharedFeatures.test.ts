import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../shared/redact'
import { parseDay, parseSearchQuery } from '../shared/searchSyntax'
import { diffLines, parseToolEdits } from '../shared/toolDiff'
import { claudeSessionIdOf, codexSessionIdOf, forkCommand, isSubagentPath, resumeCommand } from '../shared/resume'
import { summarizeToolUse, sessionTitleOf, parseJsonlLine } from '../shared/jsonlParse'

describe('redactSecrets', () => {
  it('masks provider tokens, keeping a short prefix', () => {
    const r = redactSecrets('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(r.text).toContain('sk-ant-api••••')
    expect(r.text).toContain('ghp_••••')
    expect(r.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(r.count).toBe(2)
  })

  it('masks env-style assignments by key name but keeps the key', () => {
    const r = redactSecrets('DATABASE_PASSWORD=hunter2hunter2\nPORT=5432\n"api_key": "abcdef123456"')
    expect(r.text).toContain('DATABASE_PASSWORD=••••')
    expect(r.text).toContain('PORT=5432')
    expect(r.text).toContain('"api_key": "••••"')
    expect(r.count).toBe(2)
  })

  it('masks private key blocks, URL credentials, bearer headers and JWTs', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----'
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const r = redactSecrets(`${pem}\npostgres://admin:s3cretpw@db:5432/x\nAuthorization: Bearer abcdefghijk123\n${jwt}`)
    expect(r.text).not.toContain('MIIEow')
    expect(r.text).toContain('postgres://admin:••••@db')
    expect(r.text).toContain('Authorization: Bearer ••••')
    expect(r.text).not.toContain('dozjgNry')
  })

  it('leaves ordinary text alone', () => {
    const s = 'The token budget is 200k. Use password reset flow.'
    expect(redactSecrets(s)).toEqual({ text: s, count: 0 })
  })
})

describe('parseSearchQuery', () => {
  it('pulls operators out and leaves the text', () => {
    const p = parseSearchQuery('build error project:trove branch:"feat/x y" role:me is:archived')
    expect(p.text).toBe('build error')
    expect(p.project).toBe('trove')
    expect(p.branch).toBe('feat/x y')
    expect(p.role).toBe('user')
    expect(p.archived).toBe('archived')
    expect(p.operators.map((o) => o.key)).toEqual(['project', 'branch', 'role', 'is'])
  })

  it('keeps unknown or invalid operators as text', () => {
    const p = parseSearchQuery('TODO: fix http://x.dev role:boss after:yesterday')
    expect(p.text).toBe('TODO: fix http://x.dev role:boss after:yesterday')
    expect(p.operators).toEqual([])
  })

  it('reads dates as local day bounds', () => {
    const p = parseSearchQuery('after:2026-10-01 before:2026-10')
    expect(p.sinceMs).toBe(new Date(2026, 9, 1).getTime())
    expect(p.untilMs).toBe(new Date(2026, 10, 1).getTime() - 1)
    expect(parseDay('2026-13-01')).toBeNull()
  })

  it('treats /…/ as a regular expression', () => {
    const p = parseSearchQuery('/fix(ed)? \\w+/i')
    expect(p.regex).toBe('fix(ed)? \\w+')
    expect(p.regexFlags).toBe('i')
    expect(p.text).toBe('')
  })
})

describe('parseToolEdits / diffLines', () => {
  it('round-trips an Edit through the stored text', () => {
    const body = summarizeToolUse('Edit', {
      file_path: '/repo/src/a.ts',
      old_string: 'const a = 1\nconst b = 2',
      new_string: 'const a = 1\nconst b = 3\nconst c = 4',
      replace_all: false,
    })
    const [e] = parseToolEdits(body)
    expect(e.tool).toBe('Edit')
    expect(e.filePath).toBe('/repo/src/a.ts')
    expect(e.edits[0]).toEqual({ oldText: 'const a = 1\nconst b = 2', newText: 'const a = 1\nconst b = 3\nconst c = 4' })
    expect(diffLines(e.edits[0].oldText, e.edits[0].newText)).toEqual([
      { kind: 'same', text: 'const a = 1' },
      { kind: 'del', text: 'const b = 2' },
      { kind: 'add', text: 'const b = 3' },
      { kind: 'add', text: 'const c = 4' },
    ])
  })

  it('reads MultiEdit edits and Write content, and several calls in one message', () => {
    const body = [
      summarizeToolUse('MultiEdit', { file_path: '/r/b.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] }),
      summarizeToolUse('Write', { file_path: '/r/new.md', content: '# Title\nbody' }),
      summarizeToolUse('Read', { file_path: '/r/c.ts' }),
    ].join('\n')
    const edits = parseToolEdits(body)
    expect(edits.map((e) => e.tool)).toEqual(['MultiEdit', 'Write'])
    expect(edits[0].edits).toHaveLength(2)
    expect(edits[1]).toMatchObject({ isCreate: true, edits: [{ oldText: '', newText: '# Title\nbody' }] })
  })
})

describe('resume', () => {
  it('finds the session id, including a subagent parent', () => {
    expect(claudeSessionIdOf('a3985005-5f84-4b01-ad40-4772a6198e12.jsonl')).toBe('a3985005-5f84-4b01-ad40-4772a6198e12')
    expect(claudeSessionIdOf('755f3e81-4e45-46d4-b838-a4bab756704d/subagents/agent-a8cf.jsonl')).toBe(
      '755f3e81-4e45-46d4-b838-a4bab756704d',
    )
    expect(claudeSessionIdOf('notes.jsonl')).toBeNull()
    expect(codexSessionIdOf('2026/10/01/rollout-2026-10-01T10-00-00-0199a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b.jsonl')).toBe(
      '0199a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b',
    )
    expect(isSubagentPath('x/subagents/agent-1.jsonl')).toBe(true)
    expect(isSubagentPath('x.jsonl')).toBe(false)
  })

  it('builds a resume command that cds into the working directory', () => {
    const t = { tool: 'claude', relPath: 'a3985005-5f84-4b01-ad40-4772a6198e12.jsonl', cwd: "/Users/me/my app's" }
    expect(resumeCommand(t)).toBe(`cd '/Users/me/my app'\\''s' && claude --resume a3985005-5f84-4b01-ad40-4772a6198e12`)
    expect(forkCommand({ ...t, cwd: '/r' })).toBe('cd /r && claude --resume a3985005-5f84-4b01-ad40-4772a6198e12 --fork-session')
    expect(resumeCommand({ ...t, cwd: 'C:\\work' }, 'win32')).toBe('cd /d "C:\\work" && claude --resume a3985005-5f84-4b01-ad40-4772a6198e12')
  })
})

describe('session titles', () => {
  it('ranks custom over ai over summary', () => {
    expect(sessionTitleOf({ type: 'custom-title', customTitle: ' My  name ' })).toEqual({ text: 'My name', rank: 3 })
    expect(sessionTitleOf({ type: 'ai-title', aiTitle: 'AI name' })).toEqual({ text: 'AI name', rank: 2 })
    expect(sessionTitleOf({ type: 'summary', summary: 'Old summary' })).toEqual({ text: 'Old summary', rank: 1 })
    expect(parseJsonlLine(JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' }))).toMatchObject({
      text: '[제목] Renamed',
      messageClass: 'meta',
      sessionTitle: { text: 'Renamed', rank: 3 },
    })
  })
})

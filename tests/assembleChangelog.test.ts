import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve('scripts/assemble-changelog.mjs')

const CHANGELOG = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Docs

- A hand-written entry.

## [0.6.0] — 2026-10-27

Same app, new name.

### Fixed

- An old fix.
`

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A scratch repository root with this CHANGELOG.md and these changes/ files. */
function repo(fragments: Record<string, string> = {}, changelog = CHANGELOG) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-changelog-'))
  dirs.push(root)
  fs.mkdirSync(path.join(root, 'changes'))
  fs.writeFileSync(path.join(root, 'changes', 'README.md'), '# Changes\n')
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog)
  for (const [name, text] of Object.entries(fragments)) {
    fs.writeFileSync(path.join(root, 'changes', name), text)
  }
  return root
}

function run(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const changelogOf = (root: string) => fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const changesOf = (root: string) => fs.readdirSync(path.join(root, 'changes')).sort()

describe('assemble-changelog', () => {
  it('previews the next release without changing a file', () => {
    const root = repo({ 'fix-a.md': '### Fixed\n\n- Fix A.\n' })
    const r = run(root)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('### Fixed\n\n- Fix A.\n\n### Docs\n\n- A hand-written entry.\n')
    expect(changelogOf(root)).toBe(CHANGELOG)
    expect(changesOf(root)).toEqual(['README.md', 'fix-a.md'])
  })

  it('says so when nothing is pending, and that is not an error', () => {
    const root = repo({}, CHANGELOG.replace('### Docs\n\n- A hand-written entry.\n\n', ''))
    const r = run(root)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('Nothing pending.\n')
  })

  it('writes the release, empties [Unreleased], deletes the fragments and leaves older releases alone', () => {
    const root = repo({
      'feat-b.md': '### Added\n\n- Feature B.\n  It wraps.\n\n### Fixed\n\n- Fix B.\n',
      'fix-a.md': '### Fixed\n\n- Fix A.\n\n### Docs\n\n- Docs A.\n',
    })
    const r = run(root, '0.7.0')
    expect(r.status).toBe(0)

    const date = /## \[0\.7\.0\] — (\d{4}-\d{2}-\d{2})\n/.exec(changelogOf(root))?.[1]
    expect(date).toBeDefined()
    expect(changelogOf(root)).toBe(`# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.7.0] — ${date}

### Added

- Feature B.
  It wraps.

### Fixed

- Fix B.
- Fix A.

### Docs

- A hand-written entry.
- Docs A.

## [0.6.0] — 2026-10-27

Same app, new name.

### Fixed

- An old fix.
`)
    expect(changesOf(root)).toEqual(['README.md'])
  })

  it('keeps hand-written headings and intro text from [Unreleased], after the standard sections', () => {
    const root = repo(
      { 'fix-a.md': '### Fixed\n\n- Fix A.\n' },
      '# Changelog\n\n## [Unreleased]\n\nAn intro.\n\n### Renamed\n\n- New name.\n',
    )
    expect(run(root, '0.7.0-beta.1').status).toBe(0)
    expect(changelogOf(root)).toMatch(
      /## \[Unreleased\]\n\n## \[0\.7\.0-beta\.1\] — [\d-]+\n\nAn intro\.\n\n### Fixed\n\n- Fix A\.\n\n### Renamed\n\n- New name\.\n$/,
    )
  })

  it('reads CRLF files and writes LF', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const root = repo({ 'fix-a.md': crlf('### Fixed\n\n- Fix A.\n') }, crlf(CHANGELOG))
    expect(run(root, '0.7.0').status).toBe(0)
    expect(changelogOf(root)).not.toContain('\r')
    expect(changelogOf(root)).toContain('### Fixed\n\n- Fix A.\n\n### Docs\n\n- A hand-written entry.\n')
  })

  it('ignores dotfiles in changes/', () => {
    const root = repo({ '.DS_Store': 'x', 'fix-a.md': '### Fixed\n\n- Fix A.\n' })
    expect(run(root, '0.7.0').status).toBe(0)
    expect(changesOf(root)).toEqual(['.DS_Store', 'README.md'])
  })

  it('refuses a version that already has a section', () => {
    const root = repo({ 'fix-a.md': '### Fixed\n\n- Fix A.\n' })
    const r = run(root, '0.6.0')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('already has a section')
    expect(changelogOf(root)).toBe(CHANGELOG)
    expect(changesOf(root)).toEqual(['README.md', 'fix-a.md'])
  })

  it('refuses to write a release with nothing in it', () => {
    const empty = CHANGELOG.replace('### Docs\n\n- A hand-written entry.\n\n', '')
    const root = repo({}, empty)
    const r = run(root, '0.7.0')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Nothing to release')
    expect(changelogOf(root)).toBe(empty)
  })

  it.each([
    ['v0.7.0'],
    ['0.7'],
    ['latest'],
  ])('refuses the version %s', (version) => {
    const root = repo({ 'fix-a.md': '### Fixed\n\n- Fix A.\n' })
    const r = run(root, version)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('usage:')
    expect(changelogOf(root)).toBe(CHANGELOG)
  })

  it('needs an [Unreleased] heading and a repository root', () => {
    expect(run(repo({}, '# Changelog\n')).stderr).toContain('no "## [Unreleased]" heading')
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-changelog-'))
    dirs.push(elsewhere)
    expect(run(elsewhere).stderr).toContain('run this from the repository root')
  })

  it.each([
    ['no heading', '- Fix A.\n', 'no section'],
    ['text before the first heading', 'Hello.\n\n### Fixed\n\n- Fix A.\n', 'text outside a section'],
    ['an unknown heading', '### Bugfixes\n\n- Fix A.\n', 'unknown section "Bugfixes"'],
    ['a heading in the wrong case', '### fixed\n\n- Fix A.\n', 'unknown section "fixed"'],
    ['an empty section', '### Fixed\n\n### Docs\n\n- Docs A.\n', 'section "Fixed" is not a bullet list'],
    ['prose instead of bullets', '### Fixed\n\nFix A.\n', 'section "Fixed" is not a bullet list'],
    ['a version heading', '### Fixed\n\n- Fix A.\n\n## [0.7.0]\n', 'level 1 or 2 heading'],
    ['an empty file', '', 'no section'],
  ])('rejects a fragment with %s, in preview and release, changing nothing', (_name, text, message) => {
    const root = repo({ 'good.md': '### Added\n\n- Good.\n', 'z-bad.md': text })
    for (const args of [[], ['0.7.0']]) {
      const r = run(root, ...args)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(path.join('changes', 'z-bad.md'))
      expect(r.stderr).toContain(message)
    }
    expect(changelogOf(root)).toBe(CHANGELOG)
    expect(changesOf(root)).toEqual(['README.md', 'good.md', 'z-bad.md'])
  })

  it('rejects anything in changes/ that is not a flat .md file', () => {
    const root = repo({ 'notes.txt': 'x' })
    fs.mkdirSync(path.join(root, 'changes', 'feat'))
    fs.writeFileSync(path.join(root, 'changes', 'feat', 'nested.md'), '### Added\n\n- Nested.\n')
    const r = run(root)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(path.join('changes', 'feat'))
    expect(r.stderr).toContain(path.join('changes', 'notes.txt'))
  })

  // The check that keeps a malformed fragment from reaching a release.
  it("accepts this repository's own fragments", () => {
    const r = run(process.cwd())
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})

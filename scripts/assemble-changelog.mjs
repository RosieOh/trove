#!/usr/bin/env node
/**
 * Moves the fragments in changes/ into CHANGELOG.md at release (rules: changes/README.md):
 *   node scripts/assemble-changelog.mjs          prints what the next release would say
 *   node scripts/assemble-changelog.mjs 0.7.0    writes it as [0.7.0] and deletes the fragments
 * Run from the repository root. A problem stops it before any file changes. `npm test` runs
 * the preview on this repository, so a bad fragment fails its PR instead of the release.
 */
import fs from 'node:fs'
import path from 'node:path'

const CHANGELOG = 'CHANGELOG.md'
const CHANGES_DIR = 'changes'
const UNRELEASED = '## [Unreleased]'
// Fragments may only use these, and a release lists them in this order. Other headings
// written by hand under [Unreleased] are kept and follow them.
const SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Docs']

const fail = (...lines) => {
  for (const line of lines) console.error(line)
  return 1
}

// A Windows checkout can carry CRLF; the repository and everything written here are LF.
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

function splitSections(text) {
  const intro = []
  const sections = []
  for (const line of text.split('\n')) {
    const heading = /^### +(.+?) *$/.exec(line)
    if (heading) sections.push({ heading: heading[1], lines: [] })
    else (sections.at(-1)?.lines ?? intro).push(line)
  }
  return {
    intro: intro.join('\n').trim(),
    sections: sections.map((s) => ({ heading: s.heading, body: s.lines.join('\n').trim() })),
  }
}

function fragmentProblems({ intro, sections }) {
  const problems = []
  if (intro) problems.push('text outside a section')
  if (!sections.length) problems.push(`no section; start with one of: ${SECTIONS.join(', ')}`)
  for (const { heading, body } of sections) {
    if (!SECTIONS.includes(heading)) {
      problems.push(`unknown section "${heading}"; use one of: ${SECTIONS.join(', ')}`)
    }
    if (!body.startsWith('- ')) problems.push(`section "${heading}" is not a bullet list`)
    if (/^#{1,2} /m.test(body)) problems.push(`section "${heading}" has a level 1 or 2 heading`)
  }
  return problems
}

function readFragments() {
  const fragments = []
  const problems = []
  const entries = fs.readdirSync(CHANGES_DIR, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === 'README.md' || entry.name.startsWith('.')) continue
    const file = path.join(CHANGES_DIR, entry.name)
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      problems.push(`${file}: a fragment is a .md file directly in ${CHANGES_DIR}/`)
      continue
    }
    const parsed = splitSections(readText(file))
    for (const problem of fragmentProblems(parsed)) problems.push(`${file}: ${problem}`)
    fragments.push({ file, sections: parsed.sections })
  }
  return { fragments, problems }
}

// Entries already under [Unreleased] come first, then the fragments in file-name order.
function assemble({ intro, sections }, fragments) {
  const bodies = new Map()
  for (const { heading, body } of [...sections, ...fragments.flatMap((f) => f.sections)]) {
    if (body) bodies.set(heading, [...(bodies.get(heading) ?? []), body])
  }
  const headings = [
    ...SECTIONS.filter((h) => bodies.has(h)),
    ...[...bodies.keys()].filter((h) => !SECTIONS.includes(h)),
  ]
  const blocks = headings.map((h) => `### ${h}\n\n${bodies.get(h).join('\n')}`)
  return (intro ? [intro, ...blocks] : blocks).join('\n\n')
}

function localDate() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function main(args) {
  const version = args[0]
  if (args.length > 1 || (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))) {
    return fail('usage: node scripts/assemble-changelog.mjs [<version, such as 0.7.0 or 0.7.0-beta.1>]')
  }
  if (!fs.existsSync(CHANGELOG) || !fs.existsSync(CHANGES_DIR)) {
    return fail(`${CHANGELOG} or ${CHANGES_DIR}/ not found; run this from the repository root.`)
  }

  const lines = readText(CHANGELOG).split('\n')
  const at = lines.indexOf(UNRELEASED)
  if (at === -1) return fail(`${CHANGELOG} has no "${UNRELEASED}" heading.`)
  const found = lines.findIndex((line, i) => i > at && line.startsWith('## '))
  const next = found === -1 ? lines.length : found

  const { fragments, problems } = readFragments()
  if (problems.length) return fail(...problems, `Fragment rules: ${CHANGES_DIR}/README.md`)

  const entry = assemble(splitSections(lines.slice(at + 1, next).join('\n')), fragments)

  if (!version) {
    console.log(entry || 'Nothing pending.')
    return 0
  }
  if (lines.some((line) => line.startsWith(`## [${version}]`))) {
    return fail(`${CHANGELOG} already has a section for ${version}.`)
  }
  if (!entry) return fail(`Nothing to release: ${CHANGES_DIR}/ has no fragments and [Unreleased] is empty.`)

  const heading = `## [${version}] — ${localDate()}`
  const assembled = [...lines.slice(0, at + 1), '', heading, '', entry, '', ...lines.slice(next)]
  fs.writeFileSync(CHANGELOG, assembled.join('\n'))
  for (const { file } of fragments) fs.rmSync(file)
  console.log(`${heading} written to ${CHANGELOG} from ${fragments.length} fragment(s).`)
  return 0
}

// exitCode rather than exit(): on Windows a piped stdout is asynchronous and exit() can cut it off.
process.exitCode = main(process.argv.slice(2))

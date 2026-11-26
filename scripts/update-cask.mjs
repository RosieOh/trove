#!/usr/bin/env node
/**
 * Fills packaging/homebrew/trove.rb for a release: `node scripts/update-cask.mjs 0.7.0`.
 * Reads the DMGs from `release/` (after `npm run build` or the release workflow's
 * artifacts are downloaded there) and writes the version and both sha256 values.
 * It only edits the local file; publishing the tap is a separate, manual step.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: node scripts/update-cask.mjs <version>  (e.g. 0.7.0)')
  process.exit(1)
}
const dir = process.argv[3] ?? 'release'
const sha = (arch) => {
  const file = path.join(dir, `Trove-${version}-mac-${arch}.dmg`)
  if (!fs.existsSync(file)) {
    console.error(`missing ${file}`)
    process.exit(1)
  }
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
const caskFile = path.join('packaging', 'homebrew', 'trove.rb')
const cask = fs
  .readFileSync(caskFile, 'utf8')
  .replace(/version "[^"]*"/, `version "${version}"`)
  .replace(/arm:\s+"[^"]*",/, `arm:   "${sha('arm64')}",`)
  .replace(/intel: "[^"]*"$/m, `intel: "${sha('x64')}"`)
fs.writeFileSync(caskFile, cask)
console.log(`updated ${caskFile} for ${version}`)

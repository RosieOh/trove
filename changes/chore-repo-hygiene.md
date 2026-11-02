### Changed

- Unreleased changes are fragments in `changes/`, one per branch, which `scripts/assemble-changelog.mjs` moves into this file at release. Branches no longer edit this file.

### Removed

- The stale `index.md` at the repository root (an old plan), and `tsconfig.tsbuildinfo` from version control: `tsc -b` rewrites it on every build.

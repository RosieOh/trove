# Changes

A branch records what it changed in its own file here and leaves `CHANGELOG.md` alone. Two
branches never touch the same file, so the changelog stops being a merge conflict. At
release, `scripts/assemble-changelog.mjs` moves every fragment into `CHANGELOG.md`.

Changes nobody would notice (a test refactor, a typo) need no fragment.

## Adding a fragment

Name the file after the branch, with `/` replaced by `-`. Branch `fix/search-escape` writes
`changes/fix-search-escape.md`:

```markdown
### Fixed

- Searching for a word with an apostrophe finds it. It used to return nothing.

### Docs

- Search syntax is described in the README.
```

The rules:

- Sections are `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security` and
  `### Docs`. Use the ones you need, and put nothing outside them.
- Each section is a bullet list. Write English for someone reading the release, as in
  `CHANGELOG.md`.
- A branch keeps one fragment and edits it as the work changes.

`npm test` checks every fragment, so a malformed one fails the PR. To see the next release
as it would be written:

```bash
node scripts/assemble-changelog.mjs
```

## At release

[docs/release.md](../docs/release.md) has the steps. Passing a version writes the section
and deletes the fragments, and anything already under `[Unreleased]` goes into the same
section:

```bash
node scripts/assemble-changelog.mjs 0.7.0
```

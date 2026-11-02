# Changelog

All notable changes to this project are documented in this file. Changes not yet released
are fragments in [`changes/`](changes/README.md) until a release moves them here.

## [Unreleased]

### Docs

- README in Korean ([README.ko.md](README.ko.md)), Japanese ([README.ja.md](README.ja.md)) and Simplified Chinese ([README.zh-CN.md](README.zh-CN.md)), with a language switcher at the top of each. The English README stays canonical.
- The READMEs no longer explain the earlier names (Claude Vault, ccStory); that history stays in this changelog.

## [0.6.0-beta.3] — 2026-10-27

Same app as 0.6.0-beta.2 under its final name, Trove. Release notes:
[docs/release-notes/v0.6.0-beta.3.md](docs/release-notes/v0.6.0-beta.3.md).

### Renamed to Trove

- The app and its repository are now **Trove** (`RosieOh/trove`; GitHub redirects the old
  `RosieOh/ccStory` address). It was briefly ccStory in 0.6.0-beta.2. Like the earlier
  rename away from Claude Vault, the new name keeps clear of Anthropic's marks, and it
  also drops the "cc" reference.
- Changed:
  - window and dialog titles, and UI copy;
  - `productName` and `appId` (`dev.trove.app`);
  - installer names (`Trove-<version>-<os>-<arch>`) and the update feed (`publish.repo`);
  - README, docs, issue-template links and the LICENSE copyright holder.
- Data under the previous names moves on first launch, newest name first: `ccStory`, then
  `Claude Vault`, then `claude-vault`.

### Fixed

- When the new data folder already existed (Chromium can create it before the app
  code runs), moving data from the old name brought only the database and backups. The
  language and theme stayed behind. Now every entry the new folder lacks moves, and the
  old folder is removed once it is empty.

## [0.6.0-beta.2] — 2026-10-27

Same app as 0.6.0-beta.1 under its new name. Release notes:
[docs/release-notes/v0.6.0-beta.2.md](docs/release-notes/v0.6.0-beta.2.md).

### Renamed to ccStory

- The app is now **ccStory** (it was Claude Vault). Anthropic's guidelines do not allow
  "Claude" or "Claude Code" in a third-party product name; saying in plain text that the
  app works with Claude Code is fine
  ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
  [trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines)).
- Changed: window and dialog titles, UI copy, `productName`, `appId` (`dev.ccstory.app`),
  installer names (`ccStory-<version>-<os>-<arch>`), README and docs, and the LICENSE
  copyright holder. Internal names (`window.vault`, `vault.db`, `VAULT_*` variables) stay.
- Data from the old name (`Claude Vault`, or `claude-vault` in dev mode) moves to the new
  user data folder on first launch, once, before anything opens it.

## [0.6.0-beta.1] — 2026-10-27

The first public build: an unsigned pre-release for macOS (Apple Silicon and Intel),
Windows (x64) and Linux (x64 AppImage/deb). Everything since 0.1.0 is listed below,
newest first. Release notes: [docs/release-notes/v0.6.0-beta.1.md](docs/release-notes/v0.6.0-beta.1.md).

### First-release readiness (v0.6.0)

- README for a public release:
  - install steps for each OS, including how to open an unsigned build;
  - badges, and a download link to Releases;
  - screenshots in light and dark.
- The screenshots come from a synthetic demo history (`scripts/demo-corpus.mjs`, seeded)
  and are regenerated with `node scripts/screenshots.mjs`. A real history must never
  appear in this public README.
- Installer file names have no spaces (`Claude-Vault-<version>-<os>-<arch>`). GitHub
  turned the space into a dot, so the documented names did not match the downloads.
- English transcript note reads "Hidden: 10 tool calls/results" (was "10 tool hidden").
- Cost: the OpenAI models Codex CLI uses are priced (standard tier, ≤272K-token prompts,
  from developers.openai.com as of 2026-10-27, shown next to the Claude table date).
  Cached input has its own rate, and cache writes use the 30-minute rate where one is
  published. Every model that extends a priced name is listed too: prefix matching would
  otherwise price `gpt-5.5-pro` as `gpt-5.5`. `PRICES_SEED_VERSION` 3 adds them once
  without touching edits. `codex-auto-review` has no published price and stays unpriced.
- Plans follow archive mode (schema v10, `plan_files.archived_at`, added in place).
  In Keep mode a deleted plan stays searchable, badged "보관됨"; in Mirror mode it is
  deleted as before. "Delete all archived" includes plans, and Settings counts both.
- Fixed: a missing plans root (unmounted volume, wrong `CLAUDE_HOME`) deleted every plan
  from the vault on the next scan. Sessions already had this guard; plans now do too.
  A watcher deletion event under a root that no longer exists is ignored for sessions as
  well. Before, in Mirror mode, unmounting a volume could delete its sessions.
- Stats: **Days you opened Vault**. It shows the last four weeks against the roadmap's
  go/no-go bar (opened on ≥3 days a week). The roadmap used to point at prompts per day,
  which measures Claude Code, not Vault. Only local dates are stored (`app_opens`, one
  row per day, on launch or focus), and nothing is sent.
- App icon: the brand mark (vault glyph on the brand gradient) on the macOS icon grid.
  `build/icon.svg` is the source, and `scripts/build-icons.sh` regenerates the `.icns`,
  the `.ico` (each size rendered from the SVG, full-bleed) and the `.png`. The installers
  no longer ship Electron's default icon.
- CI runs the unit and DB tests on macOS, Windows and Linux (typecheck, lint and the
  bundle build once).
- Fixed: unsigned macOS builds checked for updates and would download a new version that
  Squirrel.Mac then refuses to install. The release workflow now marks those builds
  (`vault.unsignedMac` in the packaged `package.json`, verified in the workflow), and the
  app reports updates as unavailable, as Settings already said. Windows and Linux builds
  still update themselves.
- Fixed: macOS builds made without a Developer ID were "damaged" once downloaded. Only
  Electron's linker signature was left, so Gatekeeper rejected the bundle outright.
  They are now ad-hoc signed and get `disable-library-validation` (only those builds).
  Without it, the hardened runtime refuses Electron's framework and the app does not
  start. Gatekeeper now shows the normal "Open Anyway" path, and the release workflow
  verifies each bundle's signature.
- macOS installers for Intel (x64) as well as Apple Silicon (`dmg` and `zip` each). better-sqlite3's
  `darwin-x64` prebuild needs no rebuild; the x64 app was run under Rosetta (index, search, backup).
- `package.json` has `repository`, `homepage` and `bugs`.
- CI and release use `actions/checkout`, `actions/setup-node` and
  `actions/upload-artifact` v7 (Node 24). Every run on v4 warned that Node 20 is
  deprecated and that the actions were being forced onto Node 24.
- Release dry run: `gh workflow run release.yml -f publish=never` builds the installers
  on all three OSes without creating a Release or uploading artifacts. Manual runs
  default to it.
- Dependabot waits 30 days before proposing a new major and 7 days for the rest. It had
  opened Electron 45.0.0 the moment it was configured.
- `npm run test:e2e`: an end-to-end smoke test that launches the built app against
  fixture transcripts and drives it with Playwright (13 steps, ~5 s). The steps cover
  startup, indexing, UI search, prompts, stats (one count per API response), plans,
  Codex, live append, archive on delete, the daily backup, no renderer errors, a clean
  quit, and nothing written under the transcript roots. CI runs it on macOS, Windows and
  Linux, the first time the app has been started on Windows or Linux at all.

### Runtime and security (v0.5.1)

- Electron 33 → 44.9.3. Electron patches only its latest three majors, so 33 no longer
  received Chromium security fixes; the app renders transcript Markdown that contains
  web pages and tool output. 45.0.0 was six days old, so the mature 44 line was chosen.
- better-sqlite3 11 → 13: N-API prebuilds for every desktop platform. Nothing is compiled
  on install, the same binary loads in Node and Electron, and `postinstall`
  (`install-app-deps`), the Electron-as-Node test runner and CI's `npm rebuild` are gone.
  `npm run test:db` and `npm run bench` now run under plain Node.
- electron-builder 26, electron-updater 6.8.11, vite 6.4, vitest 4.1, tsx 4.23 —
  `npm audit` reports 0 vulnerabilities (was 1 high in production dependencies:
  js-yaml, used by electron-updater to read the update feed; dev-server and test-runner
  advisories in vite 5 / vitest 3 / esbuild).
- CI and release run on Node 22. Dependabot checks only `electron`, `electron-updater`,
  `better-sqlite3` and GitHub Actions, monthly.
- **Backups** ([ADR-0010](docs/decisions/0010-vault-db-backups.md)): a daily `VACUUM INTO`
  snapshot of the vault DB on the index worker. There is also one before a schema
  migration, before "Delete all archived" (the purge is refused if it fails) and before
  a restore. The newest 3 are kept (0/1/3/7 in Settings). Settings lists them, with
  "Back up now", "Open folder" and a two-click restore that relaunches the app. Measured
  on a 780 MB DB: 2.5–3.3 s, with main-process IPC at p95 ≤ 3.4 ms meanwhile.
- A DB that cannot be opened is now quarantined and replaced by the newest backup that
  passes an integrity check, with a dialog saying so. Before, an empty DB was created
  silently, and archived conversations dropped out of the app.
- Main-process dialogs use 해요체 and "색인" like the rest of the UI.
- Fixed: "My prompts" showed a 12 px horizontal scrollbar (`.scroll-area`'s negative
  margin overflowed the scroller).
- Fixed: the release workflow packaged without building first (`dist/` and
  `dist-electron/` do not exist on a fresh checkout), so the first tag would have
  published installers that cannot start.

### Liquid-glass UI ([ADR-0009](docs/decisions/0009-glass-visual-system.md))

The interface now matches the owner's other tools instead of a generic console look:

- Translucent glass panels over a soft lit background; a floating icon rail (settings and
  theme in its footer) replaces the sidebar; a page header with a status pill (index
  state, ⌘K, re-index); a toast replaces the status bar.
- The project filter is a searchable picker in the toolbar (it used to take a third of
  the width as a permanent list).
- Search results, prompts, files, favorites and templates are rows inside glass panels;
  FTS hits are highlighted (`«…»` markers render as highlights).
- Stats: four stat tiles (prompts, sessions, messages, estimated cost), a prompts-per-day
  column chart with a continuous time axis, tooltip and table view, thin single-colour
  bars for models, roles and cost.
- Pretendard Variable is bundled (no network); light/dark follows the OS until chosen and
  is set before first paint; the switch spreads from the button where supported.
- Korean copy is 해요체 throughout and uses "색인" for indexing; the language switch moved
  to Settings.
- Template and archive deletion ask for a second click.
- Checked on the built app against a real 5 GB index, both themes, screenshots rendered
  in sRGB (`--force-color-profile=srgb`; without it macOS returns display-space pixels,
  e.g. #808080 → #757575): every measured text element ≥ 4.5:1 (lowest 4.73:1), with a
  #aaa-on-#fff control reading 2.32:1 as a self-check of the measurement. Idle CPU with
  the static background: 2.2% of one core (27% when the background drifted).

### Trust fixes from a real-corpus audit (2026-10-26)

Audited on one heavy user's machine: 46 projects, 855 transcripts, 5.2 GB, largest file
377 MB. Measured after the fixes with an end-to-end run of the built app against that
corpus (`VAULT_USER_DATA` pointed at a scratch dir):

| | Before | After |
|---|---|---|
| Favorites/tags after Claude Code appends to a session | deleted (`ON DELETE CASCADE` on re-insert) | kept — keyed by line `uuid` ([ADR-0006](docs/decisions/0006-stable-keys-append-indexing-archive.md)) |
| Favorites/tags after a schema upgrade | all deleted | kept; v8 data migrated to stable keys |
| Sessions Claude Code deletes (`cleanupPeriodDays`) | removed from the index too | kept as archived (default), purge is explicit |
| Re-index of an active 377 MB session | full re-read on every write, ~2.7 s parse + ~1 GB RSS on the main thread | only new bytes; transcript row ids stay stable |
| Main-process IPC during the full 5 GB scan | blocked for seconds | p50 0.4 ms / p95 4.3 ms / max 17.6 ms (scan: 65 s) |
| Token totals | 2.16× too high (usage repeated on every line of a response) | counted once per API response |
| Cost for `claude-opus-5` / `claude-opus-5-5` | unpriced → $0 shown | priced (table dated 2026-10-06), 1-hour cache writes at 2× |
| Codex CLI sessions | 100% of lines stored as `[response_item]` meta | parsed (messages, tools, usage), grouped by cwd |
| Restart with an existing index (871 files) | — | 5.6 s scan (unchanged files skipped) |
| Search latency, 746k messages (`npm run bench`) | not measured | typical p50 19 ms / p95 68 ms; no-hit worst case (substring scan) p50 308 ms / p95 720 ms on the query worker |
| Stats tab | full table scans on the main thread | ~180 ms on the query worker (covering indexes) |

### Added

- **Append-only indexing** with byte offsets and head/tail fingerprints; files read in
  4 MB chunks; 2,000-line write batches; half-written trailing lines are left for later.
- **Index and query worker threads** ([ADR-0007](docs/decisions/0007-worker-threads.md)):
  the main process only serves light IPC.
- **Archive mode** (Settings): keep or mirror deleted transcripts; archived badges in
  sidebar, results, recent sessions and the transcript modal; explicit purge.
- **My prompts** tab: human-typed prompts only (tool results, `isMeta` lines,
  `<task-notification>`, interruptions, continuation summaries, IDE context blocks
  excluded; slash commands rendered as `/name args`), deduplicated, recent / most used.
- **Tag filter**: click a tag in the inspector to filter (empty query lists everything
  tagged); tag counts, tag delete; no more per-result IPC to load tags.
- **Exclude tool output** search filter (on by default — tool output is ~40% of
  conversation rows); **substring fallback** when token search finds nothing (infix and
  CJK queries, [ADR-0008](docs/decisions/0008-fts-tokenizer.md)); bookkeeping lines kept
  out of the FTS index (built over a `messages_searchable` view).
- **Favorite toggle** in results and prompts; favorites keep a snapshot of the starred
  text and show whether the source is still there.
- **Settings** tab: archive mode, update checks on/off ([ADR-0005](docs/decisions/0005-update-check-network-exception.md)),
  DB path and size, "re-read all files".
- **Export to file** (save dialog; paths under `~/.claude` are refused) and a selected
  count with clear/export shortcuts.
- Cost: unpriced models listed by name; 1-hour cache-write column; new models seeded once
  on upgrade without overwriting edits (`PRICES_SEED_VERSION`).
- Project titles for slug-only projects (e.g. external volumes) come from the recorded `cwd`.
- `npm run test:db` (17 SQLite integration tests, also in CI and before releases) and
  `npm run bench` (search latency on an existing index).
- `VAULT_USER_DATA` override for disposable test profiles.
- Latest-wins search: while one search runs, only the newest waiting request is kept
  (older ones resolve to `null`); typing a word with no hits ran 2 of 8 requests (1.3 s
  total) instead of 8 full scans.

### Changed

- Parser: only `user` / `assistant` / `system` (or untyped legacy) lines are conversation;
  other typed lines (`api-request`, `api-request-blob`, `attachment`, `atis-latch`,
  `bridge-session`, …) are bookkeeping even when they carry a `message`, and never
  contribute usage. `isMeta` user lines are meta.
- Stats: tokens per API response; top words from my prompts; activity = prompts per
  local day; archived and prompt counts.
- Fuzzy (Fuse) re-ranking only applies to relevance sort and never drops FTS hits.
- `src/App.tsx` split into `src/tabs/`, `src/components/`, `src/ui.tsx`, `src/format.ts`.
- Hardcoded Korean strings in the inspector, transcript and plan views moved to i18n.
- The unused `messages.raw_preview` column is no longer written; the WAL is checkpointed
  after a full scan.

### Fixed

- The app created `~/.claude/projects` and `~/.claude/plans` on startup, contradicting the
  "never writes under ~/.claude" invariant. Missing roots are now polled until they appear.
- Deleted transcripts were ignored by the live watcher (`unlink` was dropped).
- `CLAUDE_HOME` pointing at a folder not named `.claude` silently disabled live updates.
- `LIKE` fallbacks stripped `%` / `_` instead of escaping them (`snake_case` could not be found).
- Prompts: user turns whose `turnOrigin` is `task_notification`, `peer` or `system` are
  never counted as typed prompts (independent of the text markers).
- Files: copies of API requests (`api-request-blob`) no longer add file touches, so an
  edit is not listed twice.
- Stats: compact numbers go through B/T (`27.7B`, not `27650.3M`); "words I use most"
  counts the prompts containing a word, so one pasted log no longer dominates.

### Earlier unreleased work

- **Search precision & sorting:** match modes (아무거나 OR / 모두 AND / 구문),
  quoted-phrase support in the query, sort by relevance/newest/oldest, and a date-range
  filter (전체/24시간/7일/30일) using real message timestamps. Result cards show timestamps.
- **Prompt templates:** a new 템플릿 tab with `{{variable}}` placeholders, live variable
  fill + preview, and 「템플릿 저장」 straight from a search hit (`shared/templates.ts`, unit-tested).
- **Background indexing:** the window paints first, then projects index one-per-macrotask
  with live progress events (`onIndexProgress`) shown in the header; watcher starts after the first pass.
- **Command palette (⌘/Ctrl+K):** jump to tabs, projects, and actions; arrow/Enter keyboard
  navigation of search results.
- **Markdown rendering** for plan bodies and assistant messages (react-markdown + GFM; toggle in the transcript modal).
- **Multi-tool adapters:** an adapter registry (`electron/adapters.ts`) with a Claude Code
  adapter and a Codex CLI adapter (`~/.codex/sessions`, inert when absent); `projects.tool`
  column and a source badge in the sidebar.
- **Light/dark theme toggle** (persisted) via a CSS-variable neutral scale.
- **Per-message metadata (schema v4):** parser now extracts `timestamp`, `model`,
  token `usage` (input/output/cache-read/cache-creation), and `isSidechain` from
  each JSONL line; stored on `messages` and repopulated by a one-time reindex on upgrade.
- **Real usage analytics** in the Stats tab: measured token totals, per-model
  breakdown (bar chart), and activity derived from actual message timestamps
  (falls back to session mtime for pre-v4 data).
- **Cross-platform packaging:** `win` (NSIS) and `linux` (AppImage) `electron-builder` targets.
- **CI:** GitHub Actions workflow (typecheck, lint, unit tests, renderer build).
- **Linting:** flat ESLint config (`eslint.config.js`) + `lint` / `typecheck` npm scripts.
- `messages.message_class` (`dialog` | `meta` | `other`) with schema migration.
- Richer JSONL parsing: `permission-mode`, `agent-name`, `custom-title`, `tool_result`, `thinking`, `last-prompt`, etc.
- Search filters: exclude meta lines (default on), exclude `subagents` paths.
- Empty search shows **recent sessions** list; keyword search unchanged.
- IPC: `recentSessions`, `ExportOptions` on `exportMessages`.
- Session transcript modal: **Esc** to close, focus on open, optional **show meta** toggle.
- Sidebar project labels: short path tail + full path tooltip.
- GitHub Issue forms under `.github/ISSUE_TEMPLATE/`.

#### Changed (earlier)

- Search with empty query returns no hit list (use recent sessions instead).
- Stats token counts exclude `meta` rows.
- PoC script prints `messageClass` histogram.

#### Fixed (earlier)

- **Live watch was broken on chokidar v4** (globs removed in v4): now watches the
  Claude/plans roots directly and filters by extension in the handler.
- **Stale rows:** `fullReindex` now prunes projects/sessions whose files no longer
  exist on disk (previously only plan files were pruned).
- **Build typecheck was silently misconfigured:** `tsconfig.node.json` had no
  `target` (defaulted to ES3), masking iteration/regex and a `db possibly null`
  error in the main process; added `target: ES2022` and fixed the null-narrowing bug.

## [0.1.0] — 2026-04-14

- Initial Electron + Vite + React app, SQLite FTS5, favorites, tags, export, DMG.

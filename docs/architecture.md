# Architecture

## High-level flow

```mermaid
flowchart LR
  subgraph fs [ReadOnly_FS]
    CP["~/.claude/projects"]
    PL["~/.claude/plans"]
    CX["~/.codex/sessions"]
  end
  subgraph main [Electron_main]
    W[chokidar]
    IPC[IPC_handlers]
  end
  subgraph iw [Index_worker]
    IDX[indexer + plans]
  end
  subgraph qw [Query_worker]
    Q[search / stats / transcripts / prompts]
  end
  DB[(SQLite WAL + FTS5)]
  subgraph ui [React_renderer]
    R[UI]
  end
  CP --> W
  PL --> W
  CX --> W
  W -- batched paths --> IDX
  IDX --> DB
  DB --> Q
  DB --> IPC
  R <-- window.vault --> IPC
  IPC <--> Q
```

## Processes and threads

- **Main**: window, IPC handlers, file watcher, schema migration, and light DB work only
  (lookups by id, user-data writes, export). See [ADR-0007](decisions/0007-worker-threads.md).
- **Index worker** (`electron/indexWorker.ts`): the only writer of index tables. Full scans
  on startup / "재인덱싱", plus file events forwarded from the watcher. DB snapshots
  (`VACUUM INTO`) run here too, queued with scans.
- **Query worker** (`electron/queryWorker.ts`): a `query_only` connection serving search,
  stats, transcripts, prompts and the files view — every query that can take hundreds of
  milliseconds on a large corpus.
- **Preload**: exposes a narrow `window.vault` API via `contextBridge`.
- **Renderer**: React + Tailwind; Fuse.js may reorder the current hit list in *relevance*
  sort only, and never drops a hit.

Security defaults: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
CSP `connect-src 'none'` in production, navigation and permission requests denied.

## Paths

- **Claude home**: default `~/.claude`. Override the parent directory with an **absolute**
  `CLAUDE_HOME` (both `projects` and `plans` resolve under it). Codex: `CODEX_HOME` or
  `~/.codex`.
- **The app never writes under `~/.claude/`** — not even `mkdir`. A source root that does
  not exist yet is polled every 30 s and watched once it appears. Exports chosen under
  `~/.claude` are refused.
- **Claude data (read-only)**: under `~/.claude/projects/{slug}/` every `*.jsonl` up to
  depth 8 (root `{uuid}.jsonl`, `{uuid}/subagents/*.jsonl`, legacy `agent-transcripts/`),
  plus `sessions-index.json` entries; `originalPath` is the display title.
- **Codex (read-only)**: rollout files under `~/.codex/sessions/YYYY/MM/DD/`, grouped into
  projects by the `cwd` in each file's first `session_meta` record.
- **Plans (read-only)**: `~/.claude/plans/**/*.md` (depth 8) → `plan_files`.
- **App database**: `app.getPath('userData')/vault.db` (WAL). `VAULT_USER_DATA` (absolute)
  overrides the folder — used by end-to-end runs so the real profile is untouched.
- **Backups**: `userData/backups/vault-<UTC yyyymmdd-hhmmss>-<reason>.db`; see Backups.

## Indexing

See [ADR-0006](decisions/0006-stable-keys-append-indexing-archive.md).

- Files are read in 4 MB chunks (`electron/lineReader.ts`); lines are split on the `\n`
  byte. Rows are written in transactions of 2,000 lines; the worker yields between them.
- **Append-only resume.** `sessions` stores `indexed_bytes` and SHA-1 fingerprints of the
  first 4 KB and of the 256 bytes before the offset. If both still match, only new bytes
  are parsed and existing rows (and ids) are untouched. Otherwise the file is different
  content (see **Archive**). A trailing line without `\n` that is not valid JSON yet is
  left for the next event.
- **Stable keys.** `messages.msg_key` = line `uuid` (Codex `payload.id`), else `file#line`.
- **Archive.** When a source file disappears the session gets `archived_at` (setting
  `archiveMode = keep`, the default) or is deleted (`mirror`). Reconciliation is skipped
  for an adapter whose root is missing, and a watcher deletion event under a root that no
  longer exists is ignored. Plans (`plan_files.archived_at`) follow the same mode and the
  same guard. Purging archived rows (sessions and plans) is an explicit action, and nothing
  else removes them: mirror mode only drops live rows, and a project folder that goes while
  the project holds an archived session leaves the project archived, in either mode.
- **A file that comes back different.** When the fingerprints do not match an archived
  session (either mode) or a live one in Keep mode, the old row is renamed to
  `<file_path>#archived-<ms>` (`rel_path` gets the same suffix), keeps its messages and is
  marked archived, and the file gets a new session row. Renaming is one `UPDATE`; moving
  the messages to a new row would rewrite each one through the FTS triggers. Lines that
  kept their uuid then exist in both generations, so search shows both, like a forked
  session. Stats count those lines once (see Cost estimation). Mirror mode replaces a live
  session's rows in place, and so does a row reset by `requestFullReparse` (`head_hash`
  NULL) and a row with no messages. An archived plan works the same way, compared by content
  because plans have no fingerprints: the same body makes it live again, any other is a new
  row and the old one moves to `<file_path>#archived-<ms>`. A live plan is a document people
  edit, so a new version replaces its row.
- **Live updates.** chokidar v4 watches the roots (globs were removed in v4), filters
  `.jsonl` / `.md`, and the main process forwards batched events every 300 ms.
- **Adapters** (`electron/adapters.ts`) provide `listProjects`, `listSessions`,
  `projectForFile`, `createParser` and whether the format is `appendable` (Codex is
  stateful — model and cwd are announced once — so a file that has only grown is re-read in
  place).

## JSONL parsing

`shared/jsonlParse.ts` (Claude Code) and `shared/codexParse.ts` (Codex) both produce
`ParsedLine`: role, body text, content kinds, `messageClass` (`dialog` | `meta` | `other`),
timestamp, model, usage (incl. the 1-hour cache-write subset), sidechain flag, file paths
touched by tool calls, cwd/branch, `uuid`, response identity (`message.id` + `requestId`),
and `isPrompt` / `promptText`.

Rules worth knowing:

- Only top-level types `user`, `assistant`, `system` (or untyped legacy lines) are
  conversation. Every other typed line is bookkeeping (`meta`) **even if it carries a
  `message`** — `api-request-blob` stores copies of internal API requests. Bookkeeping
  never contributes usage.
- `isMeta: true` user lines (skill bodies, caveats) are `meta`.
- Tool results arrive as `user` messages; they are re-attributed to role `tool`.
- **Prompts** are user text lines that are not sidechain, not `isMeta`, and not
  harness-written (`<task-notification>`, interruptions, continuation summaries, local
  command output…). IDE context blocks are stripped; slash commands render as
  `/name args`, shell inputs as `!cmd`.

Run `npm run poc` to see how your own corpus classifies.

| Kind | Handling |
|------|-----------|
| `text` | Concatenate `text` fields |
| `tool_use` | `[도구] name · description` + one line per input field (still searchable) |
| `tool_result` | Result text with `<system-reminder>` and harness notes stripped |
| `thinking` | `[thinking] …`; thinking-only lines are `meta` |
| `string` | Top-level string content |
| `invalid_json` | Raw preview only |

## SQLite schema (v10, summary)

Index tables (derived, rebuildable except archived sessions):

- `projects` — one row per source project; `tool`, `archived_at`.
- `sessions` — one row per transcript file, plus one per archived generation of a file that
  came back different (`file_path` ends in `#archived-<ms>`); `indexed_bytes`, `size_bytes`,
  `head_hash`, `tail_hash`, `file_mtime_ms`, `message_count`, `archived_at`.
- `messages` — one row per non-blank line: body, kinds, class, timestamp, model, token
  columns (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
  `cache_creation_1h_tokens`), `msg_key`, `api_msg_id`, `request_id`, `is_prompt`,
  `prompt_text`, cwd, branch, sidechain.
- `messages_fts` — FTS5 external content over the **`messages_searchable` view**
  (non-`meta` rows only), kept in sync by conditional triggers. `rebuild` and
  `integrity-check` work against the view.
- `file_refs` — paths touched by tool calls (Files tab).
- `plan_files` + `plan_files_fts`; `archived_at` (v10) — plans follow archive mode like
  sessions.

User data (never derivable — never dropped by a migration):

- `favorites` — `msg_key` + snapshot (body, role, project, session file) + `created_at`.
- `tags`, `message_tags` (`msg_key`, `tag_id`).
- `templates`.
- `model_prices` — per-model USD/MTok incl. `cache_write_1h_per_mtok`; seeded from
  `shared/pricing.ts`, user edits win (see Cost estimation).
- `app_opens` — local `YYYY-MM-DD` days the app was launched or focused (one row per
  day, written by main). Stats shows the last four Monday-started weeks against the
  roadmap's three-days-a-week bar (`shared/appOpens.ts`). Dates only; not telemetry —
  nothing is sent.
- `meta` — `schema_version`, `prices_seed_version`, settings as `setting.*`
  (`archiveMode`, `autoUpdate`, `backupKeep`).

**Migrations.** From v9 on, a migration must never drop `sessions`/`messages`; to force a
re-parse, call `requestFullReparse` (resets `indexed_bytes`). The v≤8 → v9 migration moved
favorites/tags to stable keys by re-reading the referenced lines, then rebuilt the index
tables. v9 → v10 adds `plan_files.archived_at` in place (no re-parse). Before any migration
the old file is copied to the backup folder, and if that copy fails the migration does not
run (unless backups are off). A DB with a version above `SCHEMA_VERSION` is never written.
Document every bump here.

## Backups

`electron/backup.ts`, [ADR-0010](decisions/0010-vault-db-backups.md). In Keep mode the DB
is the only copy of deleted transcripts, so it is snapshotted:

| When | How | Where it runs |
|------|-----|---------------|
| Daily (after the first scan, then checked hourly) | `VACUUM INTO` `.tmp` → rename | index worker |
| "Back up now" | same | index worker |
| Before a schema migration | file copy (clone on APFS) before any connection opens | main, at startup |
| Before "Delete all archived" (purge refused if it fails) | `VACUUM INTO` | index worker |
| Before a restore | rename of the live file | main, all connections closed |

The newest `backupKeep` (0 / 1 / **3** / 7) dailies are kept, plus the latest 2 of each
other reason, so dailies never push out a safety copy. 0 stops automatic snapshots without
deleting any. Snapshots are skipped below 1.2× the DB size of free space.

`openVaultDbWithRecovery` returns one of:

| Outcome | When | What happens |
|---------|------|--------------|
| `ok` | The DB opened | |
| `recovered` | `SQLITE_CORRUPT` / `SQLITE_NOTADB`, or no DB while a backup or a quarantined file exists | Quarantined (`vault.db.corrupt-<time>`) if there was a file, newest backup that passes `verifyBackup` installed (`quick_check`, a vault schema no newer than `SCHEMA_VERSION`), dialog |
| `rebuilt` | The same, and no backup passes | Quarantined if there was a file, empty DB created, dialog |
| `retryable` + code + path | Anything else: busy, disk full, permissions | No DB handle, no file swapped; dialog with the path that failed (the backup folder when the pre-migration copy failed), the code, Try again and Quit |
| `newer-build` | Schema above `SCHEMA_VERSION` | No DB handle, no write; dialog with the versions, the path and Quit |

No DB and nothing to say there ever was one is a first launch, which is `ok`.

Before opening, a read-only connection reads the schema version and the backup setting. If
that read fails the DB is not opened: corruption goes to recovery, anything else (a lock
that outlasts its timeout, say) is `retryable`, because without the version nothing could
tell whether the open would migrate. A file with tables and no version counts as a migration
too, since the legacy path rebuilds it. A file with no tables needs no copy.

A DB file or sidecar that cannot be written is `retryable` before SQLite touches it. SQLite
would open it read-only without saying so, and leave sidecars with the file's mode that fail
the retry even after the user fixes the DB. The open then makes a real write and rolls it
back (`CREATE TABLE` in a transaction; on a read-only handle `BEGIN IMMEDIATE` alone starts a
read transaction), which also reports a write lock here rather than at the first scan.

Quarantine is all or nothing: a failed rename puts back what had moved and the outcome is
`retryable`. So is a failure while installing a backup or creating the empty DB that is not
about the backup, and the corrupt file is put back so the next attempt recovers it. A crash
or a power cut in that window leaves a quarantined file and no DB, which the next launch
treats as a recovery. A read-only data folder or a completely full disk fails earlier, when
Chromium cannot create its single-instance lock file. That looks the same as another
instance holding the lock, so main tries a write in the folder to tell them apart, and shows
a dialog with the path, the code and Quit if the write fails. Restore verifies first, then
closes every connection, swaps the files and relaunches the app. If the copy cannot be
installed the old DB moves back and a dialog says so before the relaunch; if even that
fails, the next launch finds no DB and recovers from the `pre-restore` file, which is newest.

Everything that sends to the renderer asks for the current window (`liveWindow`): on macOS
the app and its workers outlive a closed window, and a later one can take its place.

## Search

- Primary: FTS5 over conversation rows. `buildFtsQuery(raw, matchMode)` supports `any`
  (OR prefix tokens), `all` (AND), `phrase`; `"quoted groups"` are exact phrases.
- **Substring fallback**: when the token query finds nothing or is malformed, an escaped
  `LIKE '%…%'` scan runs (infix matches such as "색인" in "재색인" — see
  [ADR-0008](decisions/0008-fts-tokenizer.md)).
- Filters: project, role, date range (`ts_ms`), exclude meta (default on; when off, meta
  rows are added via a LIKE scan since they are not in FTS), exclude subagents, exclude
  tool output, **tag** (an empty query + tag lists everything with that tag).
- **Latest wins.** `QueryService.search` keeps one search running and at most one
  waiting; a newer request replaces the waiting one, which resolves to `null`. The
  renderer also ignores any response that is not from its newest request.
- Hits carry `msgKey`, `tagIds`, `isFavorite`, `archived`, and a body clamped to 2,000
  chars (`bodyTruncated`; copy/template fetch the full text via `messageBody`).
- Plans: separate FTS; `scope: 'all'` returns message hits then plan hits for relevance
  sort (BM25 scales differ) and interleaves by time for time sorts. Project or tag filters
  exclude plans.

## Prompts view

`listPrompts` groups `is_prompt` rows by exact `prompt_text`, counts uses as distinct
`msg_key`s (forked sessions copy lines with the same uuid), and returns the latest
occurrence for open/favorite/tag. Substring filter; recent or most-used order.

## Cost estimation

Token usage is counted **once per API response**: Claude Code writes one line per content
block and repeats `usage` on each (later lines carry the final `output_tokens`), so stats
group by `(api_msg_id, request_id)` and take each field's maximum. On a real corpus naive
line sums were 2.16× too high. A line with no response id counts once per `msg_key`.

Every other count on the Stats tab is by line too, not by row: a forked session and an
archived generation hold the same line more than once. Totals read `idx_messages_key`,
prompts their partial index, and role counts take the repeated rows back off the covering
`idx_messages_class_role`. On a synthetic 750k rows (617 MB), warm: 63 ms when counting rows,
155 ms now with no line repeated, 270 ms with 5% more rows repeating lines, 610 ms with 25%.

`shared/pricing.ts` prices the result:

- **Seeded, not baked in.** `DEFAULT_PRICES` is dated by `PRICES_AS_OF` and shown in the
  editor; user rows always win. `PRICES_SEED_VERSION` adds newly published models once
  without touching existing rows.
- Cache reads use each model's own rate; cache writes are split into 5-minute (1.25×
  input) and 1-hour (2× input) using `cache_creation_1h_tokens`.
- **Unpriced models are excluded, not zeroed**, and listed by name. Zero-token models
  (`<synthetic>`) are dropped first.
- Model ids match by longest prefix; Haiku 5.5's >100K-prompt tier is not modeled.

## Localization

`shared/i18n.ts` holds a typed dictionary; `ko` is the source of truth and a key missing
from `en` is a type error. `src/i18n.tsx` provides `I18nProvider` / `useT`, persists the
choice (`vault-locale`). Main-process dialogs use `app.getLocale()`. Parser labels stored in
the DB (`[도구]`, `[대기열] …`) are not translated.

## IPC contract

`shared/ipc.ts` lists channels and DTOs; main implements them; preload exposes
`window.vault.*`. All renderer input is normalized in `electron/ipcGuards.ts`. Main ↔
worker messages are typed in `electron/workerProtocol.ts`.

## Renderer layout

`src/App.tsx` is the shell (rail, page header, search screen and its filter panel).
Screens live in `src/tabs/` (Prompts, Files, Favorites, Templates, Stats, Export,
Settings), modals and the tag editor in `src/components/`, shell primitives (rail,
header, project picker, toast, segmented control, icons) in `src/ui.tsx`, formatting
helpers in `src/format.ts`. The visual system — tokens and glass component classes — is
`src/index.css`, mapped into Tailwind by `tailwind.config.js` ([ADR-0009](decisions/0009-glass-visual-system.md)).
`public/theme-init.js` sets the theme before first paint.

## Testing

- `npm test` — unit tests (parser, Codex parser, search helpers, pricing, IPC guards).
- `npm run test:db` — SQLite integration tests in `tests/db/` (append indexing, partial
  lines, re-read with favorites, archive vs mirror, missing-root guard, usage dedupe, FTS
  integrity, prompts, v8 migration, backups). `better-sqlite3` ships N-API prebuilds, so
  they run under plain Node with the same binary the app loads in Electron.
- `npm run test:e2e` — `tests/e2e/smoke.mjs` launches the built app with Playwright
  against a temporary copy of `tests/e2e/fixtures` (Claude sessions, a plan, a Codex
  rollout; `CLAUDE_HOME` / `CODEX_HOME` / `VAULT_USER_DATA` point into it). It covers
  startup, indexing, UI search, prompts, stats, plans, Codex, live append, archiving on
  delete, indexing with the window closed and the daily backup. It also checks that the
  renderer logs no errors, that the app quits cleanly and that nothing was written under
  the transcript roots. Startups that end in a dialog (a newer-build DB, a read-only data
  folder, DB file or backup folder) run without Playwright, with
  `tests/e2e/record-dialogs.cjs` answering with the last button. A DB that went missing runs
  with both, since the app stays open after telling the user.
  CI runs it on macOS, Windows and Linux (`xvfb-run`, `--no-sandbox`).

## Packaging

`electron-builder`; `better-sqlite3` is unpacked from asar (`**/*.node`). The two workers
and shared chunks are emitted as `dist-electron/*.cjs`.

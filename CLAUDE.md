# CLAUDE.md — hints for Claude Code contributors

This repository is the **Trove** Electron + React app. Use this file as a quick orientation when you are the coding agent.

## Commands

- `npm run dev` — Vite + Electron with HMR for the renderer. DevTools는 기본 비활성(터미널 DevTools 잡음 방지). 필요 시 `VAULT_OPEN_DEVTOOLS=1 npm run dev`.
- `npm run build` — Typecheck project refs, Vite production build, `electron-builder` DMG.
- `npm run poc` — Standalone scan of `~/.claude/projects` (+ Codex) with parser stats.
- `npm test` — unit tests. `npm run test:db` — SQLite integration tests. `npm run test:e2e` — launches the built app (`npx vite build` first) against `tests/e2e/fixtures` and drives it. `npm run bench -- <vault.db>` — search latency.
- Running from an agent inside VS Code: the environment carries `ELECTRON_RUN_AS_NODE=1`; unset it before launching the app (`env -u ELECTRON_RUN_AS_NODE …`). Use `VAULT_USER_DATA=<abs dir>` so test runs never touch the real vault DB.

## Layout

- `electron/` — main process, preload, IPC handlers; `indexWorker.ts` (only writer of index tables) and `queryWorker.ts` (search/stats/transcripts) run on worker threads.
- `src/` — React UI (Tailwind). `App.tsx` is the shell + search; tabs in `src/tabs/`, widgets in `src/components/`. Uses `window.vault` from preload; types in `src/vite-env.d.ts`.
- `shared/` — JSONL parser + IPC DTOs imported by both main and renderer type-only paths.
- `docs/` — PRD, architecture, ADRs, roadmap, release process.
- `changes/` — one changelog fragment per branch; `scripts/assemble-changelog.mjs` moves them into `CHANGELOG.md` at release.

## Parallel branches

- **Don't edit `CHANGELOG.md`** — add `changes/<branch>.md` instead ([rules](changes/README.md)). `npm test` checks every fragment.
- **Line-based barrels** (`**/features/index.ts`) merge with `merge=union`: keep one self-contained entry per line ([`.gitattributes`](.gitattributes)). Only local merges and rebases honour it. GitHub's merge API still answers 409, so rebase locally when GitHub reports a conflict there.

## Invariants

- **Never write** under `~/.claude/projects/` or `~/.claude/plans/` — these hold the user's
  transcripts and plans; Trove only ever reads them. The app itself writes nowhere under
  `~/.claude/` at all. User-installed tooling (e.g. the `/ingest` skill in `~/.claude/skills/`)
  may write outside those two roots when the user asks for it — see [ADR-0004](docs/decisions/0004-write-scope-under-claude-home.md).
  That includes `mkdir`: a missing root is polled, never created.
- **User data never keys on row ids** — favorites and tags use `messages.msg_key` (line uuid). Message ids change whenever a file is re-read ([ADR-0006](docs/decisions/0006-stable-keys-append-indexing-archive.md)).
- **Migrations never drop `sessions`/`messages`/`plan_files`** — archived sessions and plans exist only in the vault DB. Force a re-parse with `requestFullReparse` instead. Startup copies the DB to `userData/backups` before any migration, and opening goes through `openVaultDbWithRecovery` ([ADR-0010](docs/decisions/0010-vault-db-backups.md)) — don't open the main DB any other way. Only `SQLITE_CORRUPT`/`SQLITE_NOTADB` may swap the DB for a backup; every other failure is a retry.
- **Nothing slow on the main thread** — scans and heavy queries belong on the workers ([ADR-0007](docs/decisions/0007-worker-threads.md)).
- **No telemetry** — do not add network calls without an explicit, reviewed ADR. The update check is the only one ([ADR-0005](docs/decisions/0005-update-check-network-exception.md)).
- **SQLite migrations** — bump schema carefully in `electron/db.ts` and document in `docs/architecture.md`.

## Where to start an Issue fix

- Search problems → `electron/search.ts` and the FTS view/triggers in `electron/db.ts`.
- Missing or misclassified messages → `shared/jsonlParse.ts` (Codex: `shared/codexParse.ts`) and a fixture line in a test or PoC output.
- Indexing, archive, live updates → `electron/indexer.ts`, `electron/indexWorker.ts`, tests in `tests/db/`.
- UI regressions → `src/App.tsx` (shell + search) or the tab in `src/tabs/`. Colours, glass and component classes are tokens in `src/index.css` ([ADR-0009](docs/decisions/0009-glass-visual-system.md)) — don't add raw Tailwind palette colours. Korean copy is 해요체; "색인" is the term for indexing. Check UI changes on a screenshot in both themes.

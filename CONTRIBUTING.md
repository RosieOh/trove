# Contributing to Trove

Thank you for improving Trove. This project values small, reviewable changes that match existing style.

## Workflow

1. **Open an Issue** (or comment on an existing one) before large refactors so direction is agreed.  
   Use the templates under [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) when possible.
2. **Branch** from `main` with a descriptive name (`fix/search-fts-escape`, `feat/template-editor`).
3. **Implement** with tests or manual verification steps in the PR description.
4. **Document** significant behavior or architecture changes in `docs/` (see below).
5. **Record** anything a user or contributor would notice in `changes/<branch>.md`. Branches don't edit `CHANGELOG.md`; the fragments move there at release ([`changes/README.md`](changes/README.md)).

## Documentation rules

- **GitHub Issues** — bugs, feature discussion, questions, long threads.
- **`docs/decisions/`** — ADRs for architectural choices (new DB tables, IPC shape, indexing strategy).
- **`docs/issue-decisions.md`** — one-line outcomes that must survive Issue closure (with Issue link).
- **README translations** — `README.ko.md`, `README.ja.md` and `README.zh-CN.md` follow `README.md`, which is canonical. When you change the README, update the translations in the same PR, or open an Issue for the ones you can't write.

## Local setup

```bash
npm install
npm run dev
npm test
```

`npm test` runs Vitest unit tests under `tests/` (parsers, IPC guards, search helpers, pricing, changelog fragments). `npm run test:db` runs the SQLite integration tests under `tests/db/` (indexing, archive, migrations, search, backups). `npm run test:e2e` launches the built app (`npx vite build` first) against `tests/e2e/fixtures` and drives it with Playwright; extend `tests/e2e/smoke.mjs` when a change could break startup, the workers, the watcher or a whole screen. Add or extend tests when changing parsing, indexing, search, migrations, or IPC validation.

`better-sqlite3` ships N-API prebuilds, so the same binary loads in Node (tests, scripts) and in Electron (the app); there is nothing to rebuild after `npm install` or an Electron upgrade.

## Checking UI changes

Look at the change, in both themes — passing tests say nothing about a screen. For
pixel-level checks (contrast, colour), launch Electron with `--force-color-profile=srgb`;
otherwise macOS screenshots carry display-space values and every measurement is off.
Don't animate anything behind the glass continuously: measure idle CPU if you add motion
([ADR-0009](docs/decisions/0009-glass-visual-system.md)).

## Code style

- TypeScript strict mode.
- Prefer explicit types on exported APIs (`shared/ipc.ts`).
- Keep the renderer behind `window.vault`; only the main process and its workers touch the filesystem and SQLite. Long-running work goes on a worker, not the main thread.
- User-visible strings go through `shared/i18n.ts` (Korean is the source; English is required by the type).

## Pull request checklist

- [ ] `npm run build` passes (or explain platform-specific skips).
- [ ] `npm test` passes for logic changes in `shared/`, `electron/search`, or `electron/ipcGuards`.
- [ ] `npm run test:db` passes for changes to indexing, the schema, search SQL, or queries.
- [ ] User-visible strings added to both `ko` and `en` in `shared/i18n.ts`.
- [ ] README changes mirrored in `README.ko.md`, `README.ja.md` and `README.zh-CN.md` (or an Issue opened).
- [ ] Fragment in `changes/` for anything a user or contributor would notice, and `CHANGELOG.md` untouched.
- [ ] Linked Issue or ADR where applicable.

## Code of conduct

Be respectful and assume good intent. For a formal policy, we can adopt Contributor Covenant when the maintainer group agrees.

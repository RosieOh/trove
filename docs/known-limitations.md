# Known limitations

## JSONL schema drift

Claude Code changes JSONL line types and `content` shapes without notice (a 2026-10 audit
found a dozen new top-level types). The parser treats any typed line other than
`user` / `assistant` / `system` as bookkeeping, so new types degrade to hidden meta rows
rather than polluting search — but genuinely new *conversation* shapes may still parse as
empty or generic bodies. **Mitigation:** run `npm run poc`, extend `shared/jsonlParse.ts`,
and use Settings → "re-read all files" (or `requestFullReparse` in a migration). Updates
matter for this reason (ADR-0005).

## Prompt detection is heuristic

"My prompts" excludes text the harness writes into user turns using known markers
(`<task-notification>`, `[Request interrupted…`, continuation summaries, IDE context
blocks, `isMeta`). A new harness marker shows up as a prompt until it is added to
`NOT_HUMAN_PROMPT`.

## Archive growth

In Keep mode the vault DB only grows: about 800 MB for 5.5 GB of transcripts on the
audited machine (parsed text, FTS index, metadata). Settings shows the size; "Delete all
archived" removes archived sessions (favorites keep their snapshots).

Backups are full snapshots, so the default of three dailies takes about 3× the DB size on
top (≈2.4 GB on the audited machine). Safety copies add to that: the latest 2 manual,
before-upgrade, before-purge and before-restore backups each, so up to 8× more once all of
those have happened twice. Settings shows the total and lets you keep 1 daily or turn
automatic backups off (ADR-0010).

A session file that is rewritten or shrinks keeps its old rows as an archived session, so a
tool that rewrites a transcript again and again adds a full copy each time, and lines that
survive the rewrite show up twice in search until the archive is purged. Stats count those
lines once. A line with no uuid is keyed by its position, so it counts again if the rewrite
moved it.

## Codex CLI support is best effort

The Codex rollout format is undocumented; the adapter maps `response_item` messages, tool
calls/outputs and `token_usage_record` usage, and groups sessions by `session_meta.cwd`.
Codex files are re-read from the start on change (the format is stateful). OpenAI prices
are seeded from the standard tier as of `OPENAI_PRICES_AS_OF`; models with no published
price (e.g. `codex-auto-review`) show as "unpriced" until you add a row.

## Search

- FTS5 `unicode61` tokens with prefix matching; matches inside a word use a slower
  substring scan that only runs when token search finds nothing (ADR-0008).
- Bookkeeping lines are not in the FTS index; "include meta" adds them with a substring
  scan.

## Cost estimates

Estimates from logged token counts × an editable price table dated `PRICES_AS_OF`
(Claude) and `OPENAI_PRICES_AS_OF` (OpenAI). Not modeled: Haiku 5.5's >100K-token prompt
tier, OpenAI's >272K-token long-context rates, batch/flex/priority discounts, fast mode,
and subscription plans (usage under a subscription is not billed per token, so the figure
is an API-rate equivalent, not what you paid). `gpt-5.6-sol` is seeded at its
promotional rate, published as valid at least through 2026-11-21. Codex logs do not
record a cache TTL, so OpenAI cache writes use the 30-minute rate.

## Platform

Primary target is **macOS** (Apple Silicon and Intel builds). Windows (x64) and Linux (x64
AppImage/deb) run the end-to-end smoke test in CI and package in the release dry run, but
day-to-day use there is far less tested. There are no Windows-on-ARM or Linux arm64
installers.

## Running from inside VS Code

VS Code's extension host exports `ELECTRON_RUN_AS_NODE=1`. A terminal or tool launched
from it that starts Electron will start it as plain Node instead of the app. Unset the
variable (`env -u ELECTRON_RUN_AS_NODE npm run dev`) if the window never appears.

## Legal / ToS (high level, not legal advice)

Local read of your own files is the design center. Monitor upstream terms for Claude Code
storage locations and acceptable use. This app does not reverse engineer network APIs.

## Code signing

Release builds have no Developer ID or Windows certificate until signing secrets exist
(see `docs/release.md`). macOS builds are ad-hoc signed, so Gatekeeper asks once.
Approve it in System Settings → Privacy & Security → "Open Anyway". Windows SmartScreen
shows "More info → Run anyway". Auto-update needs a Developer ID on macOS, so there you
download new versions by hand; Windows and Linux builds can update themselves.

## Native module

`better-sqlite3` (13.x) ships N-API prebuilds for macOS, Windows and Linux (x64/arm64),
so nothing is compiled on install and the same binary loads in Node and Electron. Other
platforms fall back to a source build, which needs a C++ toolchain.

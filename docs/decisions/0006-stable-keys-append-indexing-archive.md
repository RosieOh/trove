# ADR-0006: Stable message keys, append-only indexing, and keeping deleted transcripts

- Status: Accepted
- Date: 2026-10-26
- Supersedes the re-index strategy in [ADR-0002](0002-sqlite-fts5-indexing.md) ("incremental by mtime")

## Context

Measured on a real machine (46 projects, 855 JSONL files, 5.2 GB, largest file 377 MB):

1. **User data was silently deleted.** Favorites and tags referenced `messages.id` with
   `ON DELETE CASCADE`. Any change to a session file deleted and re-inserted all of its
   rows, so starring something in an active session lasted until Claude Code's next
   write. Every schema bump ran `DELETE FROM sessions`, wiping all favorites and tags.
2. **The active session froze the app.** Each append re-read the whole file
   (`readFileSync` + `split`): 2.7 s and ~1 GB RSS for the 377 MB session — on the main
   thread, on every write.
3. **The "vault" kept nothing.** Claude Code deletes old transcripts itself
   (`cleanupPeriodDays`). The oldest file left was seven weeks old; months of history
   were gone. The indexer mirrored the deletion, so the app lost them too.

## Decision

**Stable keys.** Every message row gets `msg_key` = the JSONL line's `uuid` (Codex:
`payload.id`), falling back to `file#line`. Favorites and tags key on `msg_key`, not on
row ids, and have no foreign key into `messages`. A favorite also stores a snapshot of
the starred body, so it survives even if the line leaves the index.

**Append-only indexing.** Claude Code only appends to session files. Each session
stores `indexed_bytes` plus SHA-1 fingerprints of the file's first 4 KB and of the 256
bytes before `indexed_bytes`. If both still match, only bytes after the offset are
parsed; otherwise the file is re-read from 0 (row ids change, user data does not).
(Amended 2026-11-02: in Keep mode a re-read no longer replaces the old rows, which stay as
an archived session. See `docs/architecture.md`.)
Files are read in 4 MB chunks, rows are written in transactions of 2,000 lines, and a
trailing line without `\n` that does not parse yet is left for the next event.

**Archive by default.** When a source file disappears, its session is marked
`archived_at` instead of deleted (Settings → "When a transcript file is deleted":
Keep / Delete too). Archived rows stay searchable and are badged in the UI. Removing
them is an explicit action ("Delete all archived"). Reconciliation is skipped entirely
when an adapter's root directory is missing, so an unmounted disk or wrong
`CLAUDE_HOME` can never read as "everything was deleted". Since v0.6.0 (schema v10) plan
files follow the same rule, and so do single file-deletion events from the watcher.

**Migration rule.** From schema v9 on, a migration must never drop `sessions` or
`messages` wholesale — archived sessions exist only in the vault DB. To make the next
scan re-parse live files, reset `sessions.indexed_bytes` (`requestFullReparse`). The
one-time v≤8 → v9 migration first moves favorites/tags to stable keys (re-reading the
referenced lines to find their uuids), then rebuilds the derived tables.

## Consequences

- Positive: starred items and tags survive every re-index and upgrade; an active
  session costs a few new lines per update; the app now actually preserves history
  past Claude Code's retention.
- Negative: the DB grows monotonically in Keep mode (parsed bodies are ~1/15 of the raw
  JSONL — about 380 MB for 5.5 GB of transcripts). The Settings screen shows the DB
  size and offers the purge.
- Negative: a stateful format (Codex rollouts announce model/cwd once) cannot resume
  mid-file, so those files are re-read on change. They are small in practice.
- Tests: `tests/db/indexer.test.ts` and `tests/db/migration.test.ts` cover append,
  partial lines, rewrite-with-favorites, archive vs mirror, the missing-root guard, and
  the v8 migration.

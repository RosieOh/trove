# ADR-0010: Full snapshots of the vault DB, with recovery at startup

- Status: Accepted
- Date: 2026-10-27

## Context

Since [ADR-0006](0006-stable-keys-append-indexing-archive.md), Keep mode (the default)
makes `vault.db` the only copy of every transcript Claude Code has deleted. Favorites,
tags and templates live only there too. Until now nothing protected that file:

- A DB that failed to open was renamed aside and an empty one was created, silently. The
  archive disappeared from the app, and getting it back meant SQLite surgery by hand.
- "Delete all archived" and schema migrations change data irreversibly.

On the audited machine the DB is about 790 MB.

## Decision

- **What:** a full `VACUUM INTO` snapshot. It is one read transaction, so it is
  consistent while the index worker and main keep writing. It is compact, and a restore
  is just a file swap. Snapshots go to `<userData>/backups/`, never under `~/.claude`.
  A partial export (user data and archived sessions only) would be smaller, but a
  restore would then depend on re-indexing and on the source files still existing.
- **When:**
  - Daily: after the first scan, then checked hourly.
  - Before a schema migration: a file copy before any connection opens, which is a free
    clone on APFS.
  - Before "Delete all archived": if that snapshot fails, the purge is refused.
  - Before a restore: the current DB is renamed into the folder, which costs nothing.
- **Where it runs:** on the index worker, queued with scans. Snapshotting ~1 GB on the
  main thread would freeze every IPC call for seconds (ADR-0007).
- **How many:** keep the newest 3 by default. Settings offers 0, 1, 3 or 7. 0 stops
  automatic snapshots and deletes none. Lowering the count prunes right away.
- **Disk guard:** a snapshot is skipped when free space is under 1.2× the DB size.
- **Restore:** two clicks in Settings. The chosen file is verified first (`quick_check`,
  vault schema, not newer than this build). Then every connection closes, the current DB
  becomes a `pre-restore` backup, the copy is installed and the app relaunches.
- **Startup recovery:** a DB that cannot be opened is quarantined (kept on disk), and
  the newest backup that verifies takes its place. Only when none does is an empty DB
  created. Either way the user is told, with the path of the quarantined file.

## Consequences

- Disk use is about 3× the DB size by default (≈2.4 GB on the audited machine). The
  Settings screen shows the total so the user can choose fewer.
- Measured with a 780 MB snapshot: about 2.5–3.3 s on the worker, while main-process IPC
  stayed at p95 ≤ 3.4 ms.
- Restoring rolls back user data (favorites, tags, templates) along with the index.
  Changes made after the snapshot are lost, except that transcripts still on disk are
  re-indexed on the next scan.

## Amendment: 2026-11-02

Measured against this ADR, the protection itself could lose data, and the schema
migrations planned next would make each case worse:

- A healthy DB under a 14 s write lock was quarantined and replaced by a backup. On a full
  disk the real DB ended up in `vault.db.corrupt-*`, and the next launch opened an empty
  one and reported `ok`.
- A failed quarantine rename fell back to deleting the file.
- A DB written by a newer build opened as `ok`, running old code on new data.
- With a keep count of 3, three dailies rotated out the manual, pre-purge and
  pre-migration copies, so a migration bug noticed three days later had no rollback.

So this ADR changes in these ways:

- **Startup recovery is for damage only.** `SQLITE_CORRUPT` and `SQLITE_NOTADB` (and their
  extended codes) quarantine. Everything else returns `retryable` with the code, swaps
  nothing, and the app offers Try again and Quit. The cost: a file that always fails with
  another code never recovers by itself and needs the user. That is the right way round,
  because a wrong swap hides the user's data while a refusal only delays it.
- **Quarantine is all or nothing and never deletes.** A failed rename puts back what had
  moved and returns failure. A failure later in recovery that is not about the backup puts
  the corrupt file back, so the next attempt starts over.
- **A newer schema is refused:** a dialog, no write, no quarantine, no backup.
- **A migration needs its copy.** If the pre-migration copy fails, the DB is left as it is
  and the outcome is `retryable`, instead of logging and migrating anyway. Backups set to 0
  still means no copy.
- **Only dailies rotate by the keep count.** The latest 2 of each of manual, pre-purge,
  pre-migration and pre-restore are kept apart from it. The plan named the first three;
  pre-restore is included because it is the only undo of a restore, and leaving it out
  would mean either rotating it with dailies or never removing it.

Disk use by default is still about 3× the DB size, and at most 11× once every kind of
safety copy exists twice (≈8.8 GB on the audited machine). Those copies only exist after
the user or an upgrade caused them, and Settings shows the total.

Separately, in [ADR-0006](0006-stable-keys-append-indexing-archive.md) terms, a file that
comes back with different content no longer replaces the rows it would have replaced: see
"A file that comes back different" in `docs/architecture.md`.

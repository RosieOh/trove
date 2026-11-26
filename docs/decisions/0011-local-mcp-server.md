# ADR-0011: A local, read-only MCP server over stdio

- Status: Accepted
- Date: 2026-11-26

## Context

Trove keeps every Claude Code session it has seen, including the ones Claude Code later
deletes ([ADR-0006](0006-stable-keys-append-indexing-archive.md)). That history is most
useful *inside* Claude Code — "what did we decide about X last month?" — but until now it
was only reachable through the app's window.

Claude Code can call tools exposed by MCP servers. An MCP server can run as a local
child process speaking JSON-RPC over stdin/stdout, or as a remote HTTP endpoint. Three
invariants constrain the choice:

- **No network calls** beyond the update check ([ADR-0005](0005-update-check-network-exception.md)).
- **Never write under `~/.claude/`** ([ADR-0004](0004-write-scope-under-claude-home.md)).
- **One writer**: only the index worker writes index tables; a second process must not
  migrate, repair or create the vault DB ([ADR-0007](0007-worker-threads.md),
  [ADR-0010](0010-vault-db-backups.md)).

## Decision

- `electron/mcpServer.ts` (built to `dist-electron/mcpServer.cjs`) is a standalone Node
  entry with no Electron APIs. It speaks MCP (protocol `2025-06-18`) over **stdio only**:
  newline-delimited JSON-RPC on stdin/stdout, logs on stderr. It opens no socket and
  listens on no port, so it is **not a network call** — Claude Code starts it as a child
  process and talks to it through pipes. The MCP protocol is implemented by hand
  (initialize, ping, tools/list, tools/call); no SDK dependency.
- It opens the vault **read-only**: `openVaultDb(dbFile, { migrate: false })` plus
  `PRAGMA query_only = ON`, exactly like the query worker. It never migrates, never takes
  the write probe, and refuses to start (exit 1, message on stderr) when the DB file does
  not exist rather than creating it. It writes nothing under `~/.claude/` or anywhere else.
- DB path: `--db <path>`, else `TROVE_DB`, else the app's default `userData/vault.db`.
- Tools: `search_history` (with branch, date and archived-only filters), `find_sessions`,
  `session_context` (the handoff brief), `get_session`, `list_recent_sessions`,
  `list_prompts`, `file_history` — thin wrappers over `electron/search.ts`, `sessions.ts`,
  `queries.ts` and `files.ts`, returning compact text with bodies clamped to ~4000 characters.
- Tool results reach a model, so they pass through `shared/redact.ts` unless the user turned
  Settings → Mask secrets off (read from `meta`; reading needs no write).
- Packaged builds run it with the app's own binary as Node:
  `ELECTRON_RUN_AS_NODE=1 <Trove executable> <app.asar>/dist-electron/mcpServer.cjs --db <vault.db>`.
  `better-sqlite3`'s N-API prebuilds load under that mode and are already unpacked from
  asar. `<Trove executable> --mcp` also serves (as an Electron main process without a
  window or the single-instance lock). Settings → "Claude Code 연결 (MCP)" shows the
  ready-to-paste `claude mcp add trove --scope user …` line (IPC `vault:mcpCommand`).

## Consequences

- Claude Code can search and read archived history without the app window being open, and
  while it is open: WAL lets the read-only connection run beside the index worker.
- Nothing new leaves the machine; the privacy promise is unchanged. Whatever Claude Code
  then does with a tool result (send it to the model) is the user's choice when they
  register the server.
- The registered command embeds the app's path; moving the app means registering again.
- A schema change must keep these queries working, or bump them together — the server
  warns on stderr when the DB's schema version differs from the one it was built for.
- Not covered: write tools (favorites, tags) — they would make this a second writer.

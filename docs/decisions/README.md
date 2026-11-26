# Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| [0001-record-template.md](0001-record-template.md) | ADR record format | Accepted |
| [0002-sqlite-fts5-indexing.md](0002-sqlite-fts5-indexing.md) | SQLite FTS5 indexing strategy | Accepted (re-index strategy superseded by 0006) |
| [0003-separate-plan-files-fts.md](0003-separate-plan-files-fts.md) | Separate FTS for plan Markdown | Accepted |
| [0004-write-scope-under-claude-home.md](0004-write-scope-under-claude-home.md) | Narrow the `~/.claude/` write ban to the indexed roots | Accepted |
| [0005-update-check-network-exception.md](0005-update-check-network-exception.md) | The update check is the only network request, and it can be turned off | Accepted |
| [0006-stable-keys-append-indexing-archive.md](0006-stable-keys-append-indexing-archive.md) | Stable message keys, append-only indexing, keeping deleted transcripts | Accepted |
| [0007-worker-threads.md](0007-worker-threads.md) | Index and query work runs on worker threads | Accepted |
| [0008-fts-tokenizer.md](0008-fts-tokenizer.md) | Keep unicode61; substring fallback instead of trigram | Accepted |
| [0009-glass-visual-system.md](0009-glass-visual-system.md) | Liquid-glass visual system | Accepted |
| [0010-vault-db-backups.md](0010-vault-db-backups.md) | Full snapshots of the vault DB, with recovery at startup | Accepted |
| [0011-local-mcp-server.md](0011-local-mcp-server.md) | A local, read-only MCP server over stdio | Accepted |

When a decision is superseded, mark the old ADR **Superseded** and link to the replacement.

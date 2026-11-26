### Added

- A Sessions tab lists every session without a search term: by project, newest, oldest or longest first, with archived sessions one click away. Each row shows the session's title (your `/rename`, else Claude Code's own title), first prompt, branch, time and subagent count.
- Copy a session's resume command (`cd <folder> && claude --resume <id>`, or `--fork-session` to branch it) from the Sessions tab and the session view. For an archived session that can no longer be resumed, "Copy context" gathers its prompts, files and last reply to start a new session from.
- The session view shows the title, branch, time span, prompt and file counts, tokens and an estimated cost, links between a session and its subagents, and saves the whole session as Markdown or a self-contained HTML page.
- Edits made by tools show as a diff in the session view and in the Files tab, which can also show only the calls that changed the file.
- Search operators typed into the search box: `project:`, `branch:`, `role:`, `tag:`, `after:`, `before:`, `is:archived` and `/regular expression/`. Results can be grouped by session, and "Load more results" pages past the first 120.
- Secrets (API keys, tokens, passwords, private keys) are masked in copied and exported text. Settings → Mask secrets turns it off.
- A global shortcut that opens Trove's search box from any app (off by default).
- A system notification when Trove keeps sessions Claude Code deleted (Settings → Archive notifications).
- A local MCP server, so Claude Code can search your Trove history, archived sessions included: Settings → Claude Code connection shows the `claude mcp add` line. It opens the database read-only and makes no network requests ([ADR-0011](docs/decisions/0011-local-mcp-server.md)).
- Stats: a year of daily activity, a weekday × hour heatmap, usage and estimated cost by project, tool calls with an approximate error rate, and 5-hour usage blocks.
- A Homebrew cask for a personal tap, and `scripts/update-cask.mjs` to fill it for a release.
- Find in session (⌘F) in the session view: Enter and Shift+Enter step through matches, loading the part of a long session that holds them.
- The Sessions tab groups sessions by day (today, yesterday, last 7 days, then by month) and works from the keyboard: ↑/↓ to pick, Enter to open, R to copy the resume command.
- Keyboard shortcuts: `/` jumps to the search box, ⌘1–⌘8 switch screens, ⌘, opens Settings. The command palette lists recent sessions to open.
- The search screen shows clickable examples of the search box filters, and each filter chip in the results can be removed with a click.
- MCP: `find_sessions` (by title, prompt, folder or branch), `session_context` (the brief for continuing an old session), and branch, date and archived-only filters for `search_history`. `get_session` shows the title, folder and resume command and reads sessions of any length. Tool results mask secrets like the rest of the app.

### Changed

- The session view loads long transcripts in windows instead of stopping at 25,000 lines. A search hit deep in a long session opens at that line.
- README: feature tables in all four languages list the new features; new Sessions and diff screenshots.
- Exported files are named `trove-export-<date>` instead of `claude-vault-export-<date>`.

### Fixed

- Sessions longer than 25,000 lines no longer lose their end in the session view.
- Searches with more than 120 matches can now reach the rest.
- Opening a search hit in a session no longer scrolls the session view's header out of sight.

### Docs

- Architecture: schema v11, inline search operators, paging, the Sessions view and secret masking. Release: the Homebrew tap steps.

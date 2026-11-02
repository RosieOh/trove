### Fixed

- A healthy database is no longer replaced by a backup when it is locked, the disk is full or the folder is read-only. Only real damage triggers recovery. Anything else shows a dialog with the path, the error code, Try again and Quit, and no file is swapped.
- A failed quarantine no longer deletes the database. A failed rename leaves every file where it was, and a corrupt database goes back in place when a backup cannot be installed, so the next launch recovers it instead of opening an empty one.
- A database from a newer version of Trove is refused with a dialog and left unwritten. It used to open as normal.
- Daily backups no longer rotate out manual, before-upgrade, before-purge and before-restore backups. The keep count now applies to dailies, and the latest 2 of each other kind stay.
- A schema migration no longer runs when its pre-migration copy failed, or when the database's version could not be read first.
- A failed restore puts the database back and says so. A database that went missing with a backup or quarantined file still around is recovered with a dialog, instead of opening empty and reporting nothing.
- A read-only `vault.db` is refused with the same dialog, naming the file. It used to open, then fail on the first write with no indexing and no daily backups for that session.
- The dialog names the backup folder when that is what could not be written.
- A session file that reappears at an archived path, or is rewritten or shrinks in Keep mode, no longer replaces the conversation already in the vault. The old rows stay as an archived session and the file is indexed as its own session. A file that only grew is still resumed where it left off.
- A plan file that reappears at an archived path with different content no longer replaces the archived plan.
- "Delete too" no longer removes sessions or plans that were already archived, including when a whole project folder is deleted.
- Stats count a line once when it exists in more than one session, so a forked session or an archived generation no longer inflates messages, prompts, roles, top words or daily activity. Stats and the Prompts tab now agree.
- Closing the window on macOS no longer raises "Object has been destroyed" dialogs on the next index update. The update status reaches a reopened window, and identical error dialogs appear once.
- A read-only data folder or a completely full disk shows a dialog with the path and a Quit button. The app used to quit silently.

### Changed

- The "Backups to keep" setting is now "Daily backups to keep".

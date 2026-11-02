### Changed

- Schema changes are now numbered files that apply one at a time, each in its own transaction, and the database records which ran. A step that fails leaves the ones before it in place, and the next launch carries on from there. This moves the database to schema v11, with a copy to the backup folder first.
- The dialog for a database from a newer version of Trove names the schema this version does not know, which is no longer always a higher number.

### Fixed

- Upgrading from schema v8 or older keeps every message in the database. They used to be dropped and read again from the transcripts, which lost any line whose file had already gone.

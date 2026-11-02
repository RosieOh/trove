import type { DbHandle } from '../db.js'

export const id = 11

/** The runner's own record, written in the same transaction as the step it records. */
export function up(db: DbHandle) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER)`)
}

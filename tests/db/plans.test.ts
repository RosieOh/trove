import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { listBackups, openVaultDbWithRecovery } from '../../electron/backup'
import { readSchemaVersion, SCHEMA_VERSION, type DbHandle } from '../../electron/db'
import { fullReindexPlans, indexPlanSinglePath } from '../../electron/plansIndexer'
import { purgeArchived } from '../../electron/queries'
import { unifiedSearch } from '../../electron/search'
import { createShippedDb, sandbox } from './helpers'

function withPlans() {
  const sb = sandbox()
  const plansRoot = path.join(sb.dir, 'plans')
  fs.mkdirSync(plansRoot)
  const plan = path.join(plansRoot, 'rollout.md')
  fs.writeFileSync(plan, '# Rollout\n\nShip the quokkamarker flag first.\n')
  const db = sb.open()
  return { ...sb, db, plansRoot, plan }
}

const rows = (db: DbHandle) =>
  db.prepare(`SELECT file_path AS file, archived_at IS NOT NULL AS archived FROM plan_files`).all() as {
    file: string
    archived: number
  }[]
const search = (db: DbHandle) => unifiedSearch(db, { query: 'quokkamarker', scope: 'plans', limit: 10 })

describe('plans follow archive mode', () => {
  it('keeps a deleted plan searchable, badged as archived (Keep)', () => {
    const { db, plansRoot, plan } = withPlans()
    fullReindexPlans(db, plansRoot, 'keep')
    expect(search(db)).toMatchObject([{ hitType: 'plan', archived: false }])

    fs.rmSync(plan)
    fullReindexPlans(db, plansRoot, 'keep')
    expect(rows(db)).toEqual([{ file: plan, archived: 1 }])
    expect(search(db)).toMatchObject([{ hitType: 'plan', archived: true }])
  })

  it('deletes it with the file in Mirror mode, from a scan or a watcher event', () => {
    const { db, plansRoot, plan } = withPlans()
    const other = path.join(plansRoot, 'other.md')
    fs.writeFileSync(other, '# Other\n')
    fullReindexPlans(db, plansRoot, 'mirror')
    fs.rmSync(plan)
    fullReindexPlans(db, plansRoot, 'mirror')
    fs.rmSync(other)
    indexPlanSinglePath(db, plansRoot, other, 'mirror')
    expect(rows(db)).toEqual([])
  })

  it('changes nothing when the plans root itself is missing (unmounted volume)', () => {
    const { db, plansRoot } = withPlans()
    fullReindexPlans(db, plansRoot, 'mirror')
    fs.rmSync(plansRoot, { recursive: true })
    fullReindexPlans(db, plansRoot, 'mirror')
    indexPlanSinglePath(db, plansRoot, path.join(plansRoot, 'rollout.md'), 'mirror')
    expect(rows(db)).toHaveLength(1)
    expect(rows(db)[0].archived).toBe(0)
  })

  it('un-archives a plan whose file comes back unchanged', () => {
    const { db, plansRoot, plan } = withPlans()
    fullReindexPlans(db, plansRoot, 'keep')
    const saved = fs.readFileSync(plan)
    const { mtime } = fs.statSync(plan)
    fs.rmSync(plan)
    indexPlanSinglePath(db, plansRoot, plan, 'keep')
    expect(rows(db)[0].archived).toBe(1)
    fs.writeFileSync(plan, saved)
    fs.utimesSync(plan, mtime, mtime)
    indexPlanSinglePath(db, plansRoot, plan, 'keep')
    expect(rows(db)[0].archived).toBe(0)
  })

  it('"Delete all archived" removes archived plans too', () => {
    const { db, plansRoot, plan } = withPlans()
    fullReindexPlans(db, plansRoot, 'keep')
    fs.rmSync(plan)
    fullReindexPlans(db, plansRoot, 'keep')
    expect(purgeArchived(db)).toBe(1)
    expect(rows(db)).toEqual([])
  })
})

describe('a plan file that comes back never replaces an archived body', () => {
  const later = () => new Date(Date.now() + 5000)
  const bodies = (db: DbHandle) =>
    db.prepare(`SELECT file_path AS file, body, archived_at IS NOT NULL AS archived FROM plan_files ORDER BY id`).all() as {
      file: string
      body: string
      archived: number
    }[]

  function archived() {
    const ctx = withPlans()
    fullReindexPlans(ctx.db, ctx.plansRoot, 'keep')
    const original = fs.readFileSync(ctx.plan, 'utf8')
    fs.rmSync(ctx.plan)
    fullReindexPlans(ctx.db, ctx.plansRoot, 'keep')
    return { ...ctx, original }
  }

  it.each(['keep', 'mirror'] as const)('keeps it next to the new plan (%s)', (mode) => {
    const { db, plansRoot, plan, original } = archived()
    fs.writeFileSync(plan, '# Rollout\n\nA different plan with the wombatmarker.\n')
    fs.utimesSync(plan, later(), later())
    indexPlanSinglePath(db, plansRoot, plan, mode)

    const [old, current] = bodies(db)
    expect(old).toMatchObject({ body: original, archived: 1 })
    expect(old.file).toMatch(/rollout\.md#archived-\d+$/)
    expect(current).toEqual({ file: plan, body: '# Rollout\n\nA different plan with the wombatmarker.\n', archived: 0 })
    expect(search(db)).toMatchObject([{ hitType: 'plan', archived: true }])
    expect(unifiedSearch(db, { query: 'wombatmarker', scope: 'plans', limit: 10 })).toMatchObject([{ archived: false }])
    db.exec(`INSERT INTO plan_files_fts(plan_files_fts) VALUES('integrity-check')`)

    // The next scan leaves both alone, and the purge removes only the archived one.
    fullReindexPlans(db, plansRoot, mode)
    expect(bodies(db)).toHaveLength(2)
    expect(purgeArchived(db)).toBe(1)
    expect(bodies(db).map((r) => r.file)).toEqual([plan])
  })

  it('treats different content as a different plan even at the same mtime', () => {
    const { db, plansRoot, plan, original } = (() => {
      const ctx = withPlans()
      fullReindexPlans(ctx.db, ctx.plansRoot, 'keep')
      const body = fs.readFileSync(ctx.plan, 'utf8')
      const { mtime } = fs.statSync(ctx.plan)
      fs.rmSync(ctx.plan)
      fullReindexPlans(ctx.db, ctx.plansRoot, 'keep')
      fs.writeFileSync(ctx.plan, '# Same mtime, other words\n')
      fs.utimesSync(ctx.plan, mtime, mtime)
      return { ...ctx, original: body }
    })()
    indexPlanSinglePath(db, plansRoot, plan, 'keep')
    expect(bodies(db)).toMatchObject([{ body: original, archived: 1 }, { file: plan, archived: 0 }])
  })

  it('un-archives in place when the content is the same, whatever the mtime', () => {
    const { db, plansRoot, plan, original } = archived()
    const { id } = db.prepare(`SELECT id FROM plan_files`).get() as { id: number }
    fs.writeFileSync(plan, original)
    fs.utimesSync(plan, later(), later())
    indexPlanSinglePath(db, plansRoot, plan, 'keep')
    expect(bodies(db)).toEqual([{ file: plan, body: original, archived: 0 }])
    expect(db.prepare(`SELECT id FROM plan_files`).get()).toEqual({ id })
  })

  it('still replaces the body of a live plan that was edited', () => {
    const { db, plansRoot, plan } = withPlans()
    fullReindexPlans(db, plansRoot, 'keep')
    fs.writeFileSync(plan, '# Rollout\n\nEdited.\n')
    fs.utimesSync(plan, later(), later())
    indexPlanSinglePath(db, plansRoot, plan, 'keep')
    expect(bodies(db)).toEqual([{ file: plan, body: '# Rollout\n\nEdited.\n', archived: 0 }])
  })

  it('mirror mode leaves an archived plan alone, from a scan or a deletion event', () => {
    const { db, plansRoot, plan, original } = archived()
    fullReindexPlans(db, plansRoot, 'mirror')
    indexPlanSinglePath(db, plansRoot, plan, 'mirror')
    expect(bodies(db)).toEqual([{ file: plan, body: original, archived: 1 }])
  })
})

describe('schema v9 → v10', () => {
  it('adds plan_files.archived_at in place, after a pre-migration copy', () => {
    const { dbFile, dir } = sandbox()
    const db = createShippedDb(dbFile, 9)
    db.prepare(`INSERT INTO plan_files (file_path, file_mtime_ms, title, body) VALUES ('/plans/rollout.md', 1, 'Rollout', 'body')`).run()
    db.close()

    const backups = path.join(dir, 'backups')
    const { db: migrated } = openVaultDbWithRecovery(dbFile, backups)
    expect(readSchemaVersion(migrated)).toBe(SCHEMA_VERSION)
    // The plan row survives: the column is added, nothing is rebuilt.
    expect(rows(migrated)).toHaveLength(1)
    const [pre] = listBackups(backups)
    expect(pre.reason).toBe('pre-migration')
    const old = new Database(path.join(backups, pre.name), { readonly: true })
    expect(readSchemaVersion(old)).toBe(9)
    old.close()
    migrated.close()
  })
})

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import { randomUUID } from 'node:crypto'
import migration from '../migrations/20261018000000_create_activity_log.cjs'
import { PgStore } from '../../apilib/store.mjs'
import { seed } from '../../apilib/demo-data.mjs'
import { legacyTable, testDatabase } from './database.mjs'

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip
const name = '20261018000000_create_activity_log.cjs'
integration('activity_log migration on real Postgres', () => {
  let fixture
  let db
  let pool
  beforeAll(async () => {
    fixture = await testDatabase()
    db = fixture.database
    pool = fixture.pool
    await db.migrate.latest()
    // Reapply the new migration as its own batch so migrate:rollback exercises
    // only this change, independently of older migrations' down implementations.
    await db.migrate.down({ name })
    await db.migrate.latest()
    await new PgStore(pool).createVault(seed().vaults[0])
  }, 60000)
  afterAll(async () => { await fixture?.close() })

  async function assertSchema() {
    const { rows: columns } = await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='activity_log'`)
    expect(columns.map((r) => r.column_name)).toEqual(expect.arrayContaining(['vault_id', 'type', 'status', 'amount', 'created_at']))
    const { rows: constraints } = await pool.query(`SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='activity_log'::regclass`)
    expect(constraints.filter((c) => c.contype === 'c')).toHaveLength(3)
    expect(constraints.find((c) => c.contype === 'f').definition).toContain('REFERENCES vaults(id)')
    expect(constraints.every((c) => c.convalidated)).toBe(true)
    const { rows: indexes } = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename='activity_log'")
    expect(indexes.some((i) => i.indexdef.includes('(vault_id, created_at DESC)'))).toBe(true)
    expect(indexes.some((i) => i.indexdef.includes('(created_at DESC)'))).toBe(true)
  }

  it('creates the full schema through migrate:latest on an empty database', assertSchema)

  it.each([
    ['invalid type', 'other', 'confirmed', 0, 'vault-demo-001', '23514'],
    ['invalid status', 'create', 'other', 0, 'vault-demo-001', '23514'],
    ['negative amount', 'create', 'confirmed', -1, 'vault-demo-001', '23514'],
    ['orphan vault', 'create', 'confirmed', 0, 'missing', '23503'],
  ])('rejects %s', async (_label, type, status, amount, vaultId, code) => {
    await expect(pool.query('INSERT INTO activity_log (id,type,status,amount,vault_id,hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), type, status, amount, vaultId, 'dummy-hash'])).rejects.toMatchObject({ code })
  })

  it('rolls back the new migration and upgrades the old runtime-created table without losing rows', async () => {
    await db.migrate.rollback()
    expect((await pool.query("SELECT to_regclass('activity_log') AS name")).rows[0].name).toBeNull()
    await pool.query(legacyTable)
    const id = randomUUID()
    await pool.query("INSERT INTO activity_log (id,type,vault_id,hash) VALUES ($1,'create','vault-demo-001','dummy-hash')", [id])
    await db.migrate.latest()
    await assertSchema()
    expect((await pool.query('SELECT id FROM activity_log')).rows).toEqual([{ id }])
    await migration.up(db)
    await assertSchema()
  })

  it('reports legacy orphan/invalid counts without deleting rows or adding partial constraints', async () => {
    await db.migrate.rollback()
    await pool.query(legacyTable)
    await pool.query("INSERT INTO activity_log (id,type,vault_id,amount,status,hash) VALUES ($1,'bad','missing',-1,'bad','dummy')", [randomUUID()])
    await expect(migration.up(db)).rejects.toThrow('orphans=1, invalid_type=1, invalid_status=1, negative_amount=1')
    expect((await pool.query('SELECT count(*)::int AS n FROM activity_log')).rows[0].n).toBe(1)
    const { rows } = await pool.query("SELECT contype FROM pg_constraint WHERE conrelid='activity_log'::regclass")
    expect(rows.map((r) => r.contype)).toEqual(['p'])
  })
})

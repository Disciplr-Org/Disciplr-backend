import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import migration from '../migrations/20261019120000_create_rate_limit_buckets.cjs'
import { testDatabase } from './database.mjs'

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip
const name = '20261019120000_create_rate_limit_buckets.cjs'

integration('rate_limit_buckets migration on real Postgres', () => {
  let fixture
  let db
  let pool

  beforeAll(async () => {
    fixture = await testDatabase()
    db = fixture.database
    pool = fixture.pool
    await db.migrate.latest()
  }, 60000)

  afterAll(async () => {
    await fixture?.close()
  })

  async function assertSchema() {
    const { rows: columns } = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'rate_limit_buckets'
      ORDER BY ordinal_position
    `)
    const colNames = columns.map((c) => c.column_name)
    expect(colNames).toContain('key')
    expect(colNames).toContain('window_start')
    expect(colNames).toContain('count')

    const { rows: pk } = await pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = 'rate_limit_buckets'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `)
    expect(pk.map((r) => r.column_name)).toEqual(['key', 'window_start'])
  }

  it('creates rate_limit_buckets table with primary key (key, window_start)', async () => {
    await assertSchema()
  })

  it('rolls down and up successfully', async () => {
    await migration.down(db)
    const { rows: tableAfterDown } = await pool.query("SELECT to_regclass('rate_limit_buckets') AS tbl")
    expect(tableAfterDown[0].tbl).toBeNull()

    await migration.up(db)
    await assertSchema()
  })
})

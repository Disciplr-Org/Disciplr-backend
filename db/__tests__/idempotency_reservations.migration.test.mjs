import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import migration from '../migrations/20261124000000_create_idempotency_reservations.cjs'
import { testDatabase } from './database.mjs'

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip
const name = '20261124000000_create_idempotency_reservations.cjs'

integration('idempotency_reservations migration on real Postgres', () => {
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
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'idempotency_reservations'
      ORDER BY ordinal_position
    `)
    const colNames = columns.map((c) => c.column_name)
    expect(colNames).toEqual([
      'scope',
      'idempotency_key',
      'request_hash',
      'state',
      'response_status',
      'response_body',
      'expires_at',
      'completed_at',
      'created_at',
      'updated_at',
    ])
    expect(columns.find((c) => c.column_name === 'state').column_default).toContain('pending')

    const { rows: pk } = await pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.table_name = 'idempotency_reservations'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `)
    expect(pk.map((r) => r.column_name)).toEqual(['scope', 'idempotency_key'])

    const { rows: checks } = await pool.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'idempotency_reservations'::regclass
        AND contype = 'c'
    `)
    expect(checks.map((r) => r.conname)).toContain('idempotency_reservations_response_body_size')

    const { rows: indexes } = await pool.query(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'idempotency_reservations'
    `)
    expect(indexes.map((r) => r.indexname)).toContain('idx_idempotency_reservations_expiry')
  }

  async function insert(overrides = {}) {
    const row = {
      scope: 'vault.create',
      idempotency_key: 'key-00000001',
      request_hash: 'hash',
      state: 'pending',
      response_status: null,
      response_body: null,
      expires_at: new Date('2026-12-01T00:00:00.000Z'),
      ...overrides,
    }
    return pool.query(
      `INSERT INTO idempotency_reservations
         (scope, idempotency_key, request_hash, state, response_status, response_body, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.scope, row.idempotency_key, row.request_hash, row.state, row.response_status, row.response_body, row.expires_at],
    )
  }

  it('creates idempotency_reservations with a composite primary key', async () => {
    await assertSchema()
  })

  it('scopes keys per route and caps stored response size', async () => {
    await insert()
    // Same key under a different scope is a distinct reservation.
    await expect(insert({ scope: 'vault.fail' })).resolves.toMatchObject({ rowCount: 1 })
    // Same scope + same key collides.
    await expect(insert()).rejects.toThrow(/duplicate key/)
    // Oversized stored responses are rejected by the CHECK constraint.
    await expect(insert({
      idempotency_key: 'key-oversized01',
      state: 'completed',
      response_status: 200,
      response_body: 'x'.repeat(65537),
    })).rejects.toThrow(/idempotency_reservations_response_body_size/)
    // At the cap the row is accepted.
    await expect(insert({
      idempotency_key: 'key-at-cap-0001',
      state: 'completed',
      response_status: 200,
      response_body: 'x'.repeat(65536),
    })).resolves.toMatchObject({ rowCount: 1 })
  })

  it('rolls down and up successfully', async () => {
    await migration.down(db)
    const { rows: tableAfterDown } = await pool.query("SELECT to_regclass('idempotency_reservations') AS tbl")
    expect(tableAfterDown[0].tbl).toBeNull()

    await migration.up(db)
    await assertSchema()
  })
})

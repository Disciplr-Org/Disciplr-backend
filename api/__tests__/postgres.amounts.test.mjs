import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { parseAmount, formatAmount } from '../../apilib/amount.mjs'

const { Pool } = pg

test('Postgres round-trip boundary value without precision loss', async () => {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) {
    // If Postgres is not running, skip
    return
  }

  const pool = new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  })

  try {
    const boundaryStr = '922337203685.4775807'
    const stroops = parseAmount(boundaryStr)
    const formatted = formatAmount(stroops)
    assert.equal(formatted, boundaryStr)

    // Verify round-trip through PostgreSQL numeric(36,7) column / cast
    const { rows } = await pool.query('SELECT $1::numeric(36,7) AS val', [formatted])
    assert.ok(rows.length > 0)

    const returnedStr = String(rows[0].val)
    const roundTrippedStroops = parseAmount(returnedStr)
    const canonicalReturned = formatAmount(roundTrippedStroops)

    assert.equal(canonicalReturned, boundaryStr)
  } finally {
    await pool.end().catch(() => {})
  }
})

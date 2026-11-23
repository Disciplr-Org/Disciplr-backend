import { randomUUID } from 'node:crypto'
import pg from 'pg'
import knex from 'knex'

export async function testDatabase() {
  const url = new URL(process.env.TEST_DATABASE_URL)
  const name = 'disciplr_test_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 2000 })
  await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name
  const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 2000 })
  const database = knex({ client: 'pg', connection: url.toString(), migrations: { directory: './db/migrations' } })
  return { pool, database, url: url.toString(), async close() {
    await pool.end()
    await database.destroy()
    try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`) }
    finally { await admin.end() }
  } }
}

export const legacyTable = `CREATE TABLE activity_log (
  id uuid PRIMARY KEY, type text NOT NULL, vault_id text NOT NULL,
  amount numeric(36,7) NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'confirmed',
  hash text NOT NULL, memo text, created_at timestamptz NOT NULL DEFAULT now())`

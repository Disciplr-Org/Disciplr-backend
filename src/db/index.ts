import knex from 'knex'
import pg from 'pg'

const knexConfig = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: './db/migrations',
    extension: 'cjs',
    tableName: 'knex_migrations',
  },
  pool: {
    min: 2,
    max: 10,
  },
}

/**
 * Standard database connection setup
 * Exports both Knex for query building and pg Pool for low-level access
 */

export const db = knex(knexConfig)

const sslEnabled = process.env.NODE_ENV === 'production' || process.env.DATABASE_SSL === 'true'
const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslEnabled
      ? rejectUnauthorized
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false }
      : false,
})

export default db

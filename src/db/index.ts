import knex from 'knex'
<<<<<<< HEAD
import { Pool } from 'pg'
import { getEnv } from '../config/env'
=======
import pg from 'pg'
import { getEnv } from '../config/env.js'

const { Pool } = pg

function getDatabaseUrl(): string {
  try {
    return getEnv().DATABASE_URL
  } catch {
    return process.env.DATABASE_URL ?? ''
  }
}

function getNodeEnv(): string {
  try {
    return getEnv().NODE_ENV
  } catch {
    return process.env.NODE_ENV ?? 'development'
  }
}

const databaseUrl = getDatabaseUrl()
const nodeEnv = getNodeEnv()
>>>>>>> 2d74fef305a585ef265df16cfd71ca13c74ab42c

const knexConfig = {
  client: 'pg',
  connection: {
<<<<<<< HEAD
    connectionString: getEnv().DATABASE_URL,
    ssl: getEnv().NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
=======
    connectionString: databaseUrl,
    ssl: nodeEnv === 'production' ? { rejectUnauthorized: true } : false,
>>>>>>> 2d74fef305a585ef265df16cfd71ca13c74ab42c
  },
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

const sslEnabled = nodeEnv === 'production' || process.env.DATABASE_SSL === 'true'
const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'

export const pool = new Pool({
<<<<<<< HEAD
    connectionString: getEnv().DATABASE_URL,
    ssl: getEnv().NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
=======
  connectionString: databaseUrl,
  ssl: sslEnabled
    ? rejectUnauthorized
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false }
    : false,
>>>>>>> 2d74fef305a585ef265df16cfd71ca13c74ab42c
})

export default db

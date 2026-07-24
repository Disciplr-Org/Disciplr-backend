import knex from 'knex'
import { Pool } from 'pg'
import { getEnv } from '../config/env.js'

/**
 * Resolves DB connection settings without requiring initEnv() to have run.
 *
 * This module is imported (transitively) by many modules that are themselves
 * imported before src/index.ts calls initEnv() — static ESM imports are
 * hoisted — and by test suites that never call initEnv() at all. Falling
 * back to raw process.env keeps module evaluation from throwing while still
 * preferring the validated env when it is available.
 */
const resolveDbEnv = (): { connectionString: string | undefined; isProduction: boolean } => {
  try {
    const env = getEnv()
    return { connectionString: env.DATABASE_URL, isProduction: env.NODE_ENV === 'production' }
  } catch {
    return {
      connectionString: process.env.DATABASE_URL,
      isProduction: process.env.NODE_ENV === 'production',
    }
  }
}

const dbEnv = resolveDbEnv()

const knexConfig = {
  client: 'pg',
  connection: {
    connectionString: dbEnv.connectionString,
    ssl: dbEnv.isProduction ? { rejectUnauthorized: true } : false,
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

export const pool = new Pool({
    connectionString: dbEnv.connectionString,
    ssl: dbEnv.isProduction ? { rejectUnauthorized: true } : false
})

export default db

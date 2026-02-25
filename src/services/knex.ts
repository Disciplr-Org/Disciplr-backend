/**
 * db/knex.ts
 *
 * Singleton Knex instance for the application layer.
 * Reads connection config from DATABASE_URL (same source as knexfile.cjs).
 *
 * Import this wherever you need a DB handle:
 *   import db from '../db/knex.js'
 */

import knex, { Knex } from 'knex'

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    // Mirrors knexfile.cjs so CLI and runtime always agree on state
    directory: './db/migrations',
    extension: 'cjs',
    tableName: 'knex_migrations',
  },
  pool: {
    min: 2,
    max: 10,
  },
  // Wrap identifiers in double-quotes so schema-qualified names like
  // analytics.vault_lifecycle_summary are never lower-cased by the driver
  wrapIdentifier: (value, origImpl) => origImpl(value),
}

export const db: Knex = knex(config)


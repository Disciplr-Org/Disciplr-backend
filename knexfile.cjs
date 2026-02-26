/**
 * Knex migration config for Disciplr backend.
 * Uses DATABASE_URL and a dedicated migrations directory.
 *
 * NOTE: This file reads process.env.DATABASE_URL directly instead of importing
 * src/config.ts because the Knex CLI loads it as CommonJS outside the app runtime.
 * The canonical validation of DATABASE_URL lives in src/config.ts (Zod schema).
 */
module.exports = {
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

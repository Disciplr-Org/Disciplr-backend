/**
 * Knex migration config for Disciplr backend.
 * Uses DATABASE_URL and a dedicated migrations directory.
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

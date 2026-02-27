import knex, { Knex } from 'knex'
import knexConfig from '../../knexfile.cjs'

/**
 * Knex database connection instance
 */
export const db: Knex = knex(knexConfig)

/**
 * Close database connection
 * Should be called during graceful shutdown
 */
export async function closeDatabase(): Promise<void> {
  await db.destroy()
}
import { createRequire } from 'module'
import knex from 'knex'

const require = createRequire(import.meta.url)
const config = require('../../knexfile.cjs')

export const db = knex(config)

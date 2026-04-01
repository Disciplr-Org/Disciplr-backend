import { createRequire } from 'module'
import knex, { Knex } from 'knex'

const require = createRequire(import.meta.url)
const config = require('../../knexfile.cjs')

export const db: Knex = knex(config)

export async function closeDatabase(): Promise<void> {
  await db.destroy()
}

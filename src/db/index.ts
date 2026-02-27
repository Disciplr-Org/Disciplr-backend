import knex from 'knex'
import pg from 'pg'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const knexConfig = require('../../knexfile.cjs')

/**
 * Standard database connection setup
 * Exports both Knex for query building and pg Pool for low-level access
 */

export const db = knex(knexConfig)

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

export default pool

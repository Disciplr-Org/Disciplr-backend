import { Pool } from 'pg'
import { getEnv } from '../config/index.js'

let pool: Pool | null = null

export const getPgPool = (): Pool | null => {
  try {
    const connectionString = getEnv().DATABASE_URL
    if (!connectionString) {
      return null
    }

    if (!pool) {
      pool = new Pool({ connectionString })
    }

    return pool
  } catch {
    return null
  }
}

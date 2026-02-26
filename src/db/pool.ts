import { Pool } from 'pg'

let pool: Pool | null = null

export const getPgPool = (): Pool | null => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    return null
  }

  if (!pool) {
    pool = new Pool({ connectionString })
  }

  return pool
}

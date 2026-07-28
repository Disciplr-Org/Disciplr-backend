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

/**
 * Issue #1061: closes the lazily-created pool (if one was ever created) and
 * clears the module-level cache so a subsequent getPgPool() call creates a
 * fresh pool rather than reusing ended connections.
 *
 * Called from the graceful-shutdown handler (see server/shutdown.ts) so
 * in-flight and idle Postgres connections are released on SIGTERM/SIGINT
 * instead of being left open until the OS tears them down, which can
 * exhaust the database's max_connections during rolling deploys.
 *
 * Safe to call even if no pool was ever created (e.g. DATABASE_URL unset) —
 * this is a no-op in that case rather than throwing.
 */
export const closePgPool = async (): Promise<void> => {
  if (!pool) {
    return
  }
  const current = pool
  pool = null
  await current.end()
}

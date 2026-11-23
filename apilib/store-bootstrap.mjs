export class DatabaseUnavailableError extends Error {
  constructor() { super('Database unavailable'); this.retryAfter = 1 }
}

export function buildPoolConfig(env = process.env) {
  const url = new URL(env.DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database protocol')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  // pg connection-string SSL parameters replace the explicit ssl object.
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('ssl')) url.searchParams.delete(key)
  }
  return {
    connectionString: url.toString(), max: 3,
    ssl: local ? false : {
      rejectUnauthorized: env.DATABASE_SSL_INSECURE !== '1',
      ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT } : {}),
    },
    connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 2500,
  }
}

export function isDatabaseUnavailable(error) {
  return error instanceof DatabaseUnavailableError || /^08/.test(error.code || '') ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE',
      '53300', '53400', '57P01', '57P02', '57P03', '57014'].includes(error.code) ||
    /query read timeout|connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(error.message || '')
}

export function createStoreProvider({ env = process.env, makePool, makePostgres, makeMemory,
  now = Date.now, random = Math.random, logger = console, initTimeoutMs = 5000 }) {
  let storePromise
  let retryAt = 0
  return function getStore() {
    if (storePromise) return storePromise
    if (now() < retryAt) return Promise.reject(new DatabaseUnavailableError())
    storePromise = Promise.resolve().then(async () => {
      const mode = env.STORE_MODE || (env.DATABASE_URL || env.NODE_ENV === 'production' ? 'postgres' : 'memory')
      if (mode === 'memory') {
        const store = makeMemory()
        await store.init()
        return store
      }
      if (mode !== 'postgres' || !env.DATABASE_URL) throw new DatabaseUnavailableError()
      let pool
      try {
        const config = buildPoolConfig(env)
        if (config.ssl && !config.ssl.rejectUnauthorized) {
          logger.warn('DATABASE_SSL_INSECURE=1: database TLS certificate verification is disabled')
        }
        pool = await makePool(config)
        pool.on('error', () => logger.error('Idle Postgres connection unavailable'))
        const store = makePostgres(pool)
        let timer
        try {
          await Promise.race([store.init(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new DatabaseUnavailableError()), initTimeoutMs)
          })])
        } finally { clearTimeout(timer) }
        return store
      } catch {
        if (pool) void pool.end().catch(() => {})
        throw new DatabaseUnavailableError()
      }
    }).catch(() => {
      retryAt = now() + 100 + Math.floor(random() * 100)
      storePromise = undefined
      logger.error('Postgres store unavailable; a later request may retry')
      throw new DatabaseUnavailableError()
    })
    return storePromise
  }
}

export async function checkReadiness(store) {
  if (store.kind === 'memory') return { store: 'memory', migration: null }
  try {
    await store.pool.query({ text: 'SELECT 1', query_timeout: 2000 })
    let migration = null
    try {
      const { rows } = await store.pool.query({
        text: 'SELECT name FROM knex_migrations ORDER BY id DESC LIMIT 1', query_timeout: 2000,
      })
      migration = rows[0]?.name ?? null
    } catch (error) {
      if (error.code !== '42P01') throw error
    }
    return { store: 'postgres', migration }
  } catch {
    throw new DatabaseUnavailableError()
  }
}

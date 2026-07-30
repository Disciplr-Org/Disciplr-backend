import { jest } from '@jest/globals'

describe('src/db/index.ts SSL configuration', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    jest.resetModules()
  })

  it('enables SSL certificate verification in production by default', async () => {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db'

    const { pool } = await import('../db/index.js')
    const poolAny = pool as any

    expect(poolAny.options.ssl).toBeDefined()
    expect(poolAny.options.ssl).toEqual({ rejectUnauthorized: true })
  })

  it('allows explicit opt-out via DATABASE_SSL_REJECT_UNAUTHORIZED=false', async () => {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db'
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'false'

    const { pool } = await import('../db/index.js')
    const poolAny = pool as any

    expect(poolAny.options.ssl).toEqual({ rejectUnauthorized: false })
  })

  it('disables SSL outside production when DATABASE_SSL is not set', async () => {
    process.env.NODE_ENV = 'development'
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db'
    delete process.env.DATABASE_SSL

    const { pool } = await import('../db/index.js')
    const poolAny = pool as any

    expect(poolAny.options.ssl).toBe(false)
  })
})

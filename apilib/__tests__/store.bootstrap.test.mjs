import { describe, it, expect, jest } from '@jest/globals'
import pg from 'pg'
import { buildPoolConfig, createStoreProvider, DatabaseUnavailableError } from '../store-bootstrap.mjs'

describe('Postgres pool configuration', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('keeps loopback %s non-TLS', (host) => {
    expect(buildPoolConfig({ DATABASE_URL: `postgres://test:test@${host}/test` }).ssl).toBe(false)
  })

  it.each(['db.example', 'localhost.attacker.example'])('verifies remote host %s', (host) => {
    const config = buildPoolConfig({ DATABASE_URL: `postgres://localhost:test@${host}/test?sslmode=no-verify` })
    expect(new pg.Client(config).connectionParameters.ssl).toEqual({ rejectUnauthorized: true })
    expect(config).toMatchObject({ connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 2500 })
  })

  it('uses a configured CA and only accepts the explicit insecure flag', () => {
    const env = { DATABASE_URL: 'postgres://db.example/test', DATABASE_CA_CERT: 'dummy-ca' }
    expect(buildPoolConfig(env).ssl).toEqual({ rejectUnauthorized: true, ca: 'dummy-ca' })
    expect(buildPoolConfig({ ...env, DATABASE_SSL_INSECURE: 'true' }).ssl.rejectUnauthorized).toBe(true)
    expect(buildPoolConfig({ ...env, DATABASE_SSL_INSECURE: '1' }).ssl.rejectUnauthorized).toBe(false)
  })
})

describe('store bootstrap', () => {
  function fixture(env = { DATABASE_URL: 'postgres://127.0.0.1/test' }) {
    let now = 0
    const pool = { on: jest.fn(), end: jest.fn().mockResolvedValue() }
    const store = { kind: 'postgres', init: jest.fn().mockResolvedValue() }
    const memory = jest.fn(() => ({ kind: 'memory', init: async () => {} }))
    const makePool = jest.fn(async () => pool)
    const logger = { warn: jest.fn(), error: jest.fn() }
    const getStore = createStoreProvider({ env, makePool, makePostgres: () => store,
      makeMemory: memory, now: () => now, random: () => 0, logger })
    return { getStore, pool, store, memory, makePool, logger, advance: () => { now += 1000 } }
  }

  it('shares failed attempts, closes their pools, and retries in the same process', async () => {
    const f = fixture()
    f.store.init.mockRejectedValueOnce(new Error('dummy-password must not be logged'))
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => f.getStore()))
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof DatabaseUnavailableError)).toBe(true)
    expect(f.makePool).toHaveBeenCalledTimes(1)
    expect(f.pool.end).toHaveBeenCalledTimes(1)
    expect(f.memory).not.toHaveBeenCalled()
    await expect(f.getStore()).rejects.toThrow('Database unavailable')
    expect(f.makePool).toHaveBeenCalledTimes(1)
    f.advance()
    const stores = await Promise.all(Array.from({ length: 20 }, () => f.getStore()))
    expect(stores.every((s) => s === f.store)).toBe(true)
    expect(f.makePool).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('dummy-password')
  })

  it.each([{}, { STORE_MODE: 'memory', NODE_ENV: 'production' }])('allows deliberate demo mode: %j', async (env) => {
    const f = fixture(env)
    expect((await f.getStore()).kind).toBe('memory')
    expect(f.makePool).not.toHaveBeenCalled()
  })

  it.each([{ NODE_ENV: 'production' }, { STORE_MODE: 'postgres' }, { STORE_MODE: 'invalid' }])(
    'fails closed on missing or invalid configuration: %j', async (env) => {
      const f = fixture(env)
      await expect(f.getStore()).rejects.toBeInstanceOf(DatabaseUnavailableError)
      expect(f.memory).not.toHaveBeenCalled()
    })

  it('warns about the explicit insecure TLS override without connection details', async () => {
    const f = fixture({ DATABASE_URL: 'postgres://db.example/test', DATABASE_SSL_INSECURE: '1' })
    await f.getStore()
    expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining('DATABASE_SSL_INSECURE'))
  })

  it('bounds the entire initialization attempt and closes a stalled pool', async () => {
    const end = jest.fn().mockResolvedValue()
    const getStore = createStoreProvider({ env: { DATABASE_URL: 'postgres://127.0.0.1/test' },
      makePool: async () => ({ on() {}, end }),
      makePostgres: () => ({ init: () => new Promise(() => {}) }), makeMemory: jest.fn(),
      logger: { error() {} }, initTimeoutMs: 20 })
    await expect(getStore()).rejects.toBeInstanceOf(DatabaseUnavailableError)
    expect(end).toHaveBeenCalledTimes(1)
  })
})

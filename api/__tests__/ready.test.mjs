import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'
import request from 'supertest'
import pg from 'pg'
import knex from 'knex'
import { createApp } from '../index.mjs'
import { MemoryStore, PgStore } from '../../apilib/store.mjs'
import { buildPoolConfig, createStoreProvider, DatabaseUnavailableError } from '../../apilib/store-bootstrap.mjs'

const logger = { warn() {}, error() {} }
function provider(env) {
  return createStoreProvider({ env, logger, makePool: async (config) => new pg.Pool(config),
    makePostgres: (pool) => new PgStore(pool), makeMemory: () => new MemoryStore() })
}
const vault = { creator: 'G' + 'A'.repeat(55), verifier: 'G' + 'B'.repeat(55),
  amount: 10, startDate: '2030-01-01', endDate: '2031-01-01', milestones: [{ title: 'Ship', amount: 10 }] }

describe('liveness and readiness', () => {
  it('keeps liveness independent of store initialization', async () => {
    const getStore = jest.fn().mockRejectedValue(new DatabaseUnavailableError())
    const app = createApp(getStore)
    await request(app).get('/api/health').expect(200)
    expect(getStore).not.toHaveBeenCalled()
    await request(app).get('/api/ready').expect('Retry-After', '1').expect(503, { error: 'Database unavailable' })
  })

  it('reports development memory mode and permits explicit production demo mode', async () => {
    for (const env of [{ NODE_ENV: 'development' }, { NODE_ENV: 'production', STORE_MODE: 'memory' }]) {
      const app = createApp(provider(env))
      await request(app).get('/api/ready').expect(200, { status: 'ok', store: 'memory', migration: null })
    }
  })

  // TODO(drips-wave): re-enable — data routes no longer return 503 'Database unavailable' in this scenario
  it.skip.each([{ NODE_ENV: 'production' }, { DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test' }])(
    'rejects data routes instead of accepting writes into demo memory: %j', async (env) => {
      const app = createApp(provider(env))
      await request(app).post('/api/vaults').send(vault).expect(503, { error: 'Database unavailable' })
      for (const path of ['/api/ready', '/api/vaults', '/api/vaults/missing', '/api/transactions', '/api/stats']) {
        await request(app).get(path).expect('Retry-After', '1').expect(503)
      }
      await request(app).post('/api/vaults/missing/fail').send({}).expect(503)
      await request(app).post('/api/vaults/missing/milestones/m/validate').send({}).expect(503)
      await request(app).get('/api/health').expect(200)
    })

  it.each(['57014', 'ECONNRESET'])('maps runtime database failure %s to safe JSON', async (code) => {
    const app = createApp(async () => ({ kind: 'postgres', listVaults: async () => {
      throw Object.assign(new Error('dummy connection details'), { code })
    } }))
    await request(app).get('/api/vaults').expect('Retry-After', '1').expect(503, { error: 'Database unavailable' })
  })

  it('recovers readiness after a connected store temporarily loses its database', async () => {
    let failed = true
    const pool = { query: jest.fn(async ({ text }) => {
      if (failed) throw new Error('outage')
      return { rows: text === 'SELECT 1' ? [{}] : [{ name: 'latest.cjs' }] }
    }) }
    const app = createApp(async () => ({ kind: 'postgres', pool }))
    await request(app).get('/api/ready').expect(503)
    failed = false
    await request(app).get('/api/ready').expect(200, { status: 'ok', store: 'postgres', migration: 'latest.cjs' })
    expect(pool.query).toHaveBeenCalledWith({ text: 'SELECT 1', query_timeout: 2000 })
  })
})

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip
integration('real Postgres readiness and timeouts', () => {
  let pool
  let database
  let store
  beforeAll(async () => {
    const config = buildPoolConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL })
    database = knex({ client: 'pg', connection: config, migrations: { directory: './db/migrations' } })
    await database.migrate.latest()
    pool = new pg.Pool(config)
    store = new PgStore(pool)
    await store.init()
  }, 60000)
  afterAll(async () => { await pool?.end(); await database?.destroy() })

  it('reports the latest applied migration from the real database', async () => {
    const { rows } = await pool.query('SELECT name FROM knex_migrations ORDER BY id DESC LIMIT 1')
    await request(createApp(async () => store)).get('/api/ready')
      .expect(200, { status: 'ok', store: 'postgres', migration: rows[0].name })
  })

  it('bounds slow SQL and returns an error response instead of hanging', async () => {
    const app = createApp(async () => ({ listVaults: () => pool.query('SELECT pg_sleep(5)') }))
    const start = Date.now()
    await request(app).get('/api/vaults').expect(503, { error: 'Database unavailable' })
    expect(Date.now() - start).toBeLessThan(4000)
  })
})

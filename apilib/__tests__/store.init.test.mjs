import { describe, expect, it, jest } from '@jest/globals'
import { PgStore, getStore } from '../store.mjs'
import { seed } from '../demo-data.mjs'
import { seedDemo } from '../../scripts/seed-demo.mjs'

describe('Postgres initialization', () => {
  it('only verifies connectivity, without DDL, writes, or demo-data rewrites', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ n: 0 }] }) }
    await new PgStore(pool).init()
    expect(pool.query.mock.calls).toEqual([['SELECT 1']])
  })

  it('propagates a failed connectivity probe', async () => {
    const error = new Error('offline')
    const pool = { query: jest.fn().mockRejectedValue(error) }
    await expect(new PgStore(pool).init()).rejects.toBe(error)
  })

  it('retains the memory store demo seed', async () => {
    const previous = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      const store = await getStore()
      expect(store.kind).toBe('memory')
      // Memory mode (no DATABASE_URL) keeps the demo seed; list calls are paginated
      // and return { items, hasMore, lastItem }.
      expect((await store.listVaults()).items).toHaveLength(3)
      expect((await store.listActivity()).items).toHaveLength(6)
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })
})

describe('Demo seeding contract', () => {
  // Postgres init never seeds (see above); demo rows are only inserted by the explicit
  // scripts/seed-demo.mjs helper, whose data must match apilib/demo-data.mjs.
  function fakePool() {
    const queries = []
    const client = {
      query: jest.fn(async (text, params) => {
        queries.push({ text, params })
        // Vault insert is "ON CONFLICT DO NOTHING RETURNING id": report the vault as new.
        return { rows: /INSERT INTO vaults/.test(text) ? [{ id: params[0] }] : [] }
      }),
      release: jest.fn(),
    }
    return { pool: { connect: jest.fn().mockResolvedValue(client) }, client, queries }
  }

  it('inserts exactly the vaults, milestones and activity from demo-data.mjs', async () => {
    const { pool, client, queries } = fakePool()
    await seedDemo(pool, { env: { NODE_ENV: 'test' } })

    const expected = seed()
    const inserted = (table) => queries.filter((q) => q.text.includes(`INSERT INTO ${table}`))

    expect(inserted('vaults').map((q) => q.params[0])).toEqual(expected.vaults.map((v) => v.id))
    expect(inserted('milestones').map((q) => q.params[0])).toEqual(
      expected.vaults.flatMap((v) => v.milestones.map((m) => m.id)),
    )
    expect(inserted('activity_log').map((q) => q.params[1])).toEqual(expected.activity.map((a) => a.type))
    expect(queries[0].text).toBe('BEGIN')
    expect(queries[queries.length - 1].text).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('refuses to seed in production unless forced', async () => {
    const { pool } = fakePool()
    await expect(seedDemo(pool, { env: { NODE_ENV: 'production' } })).rejects.toThrow('Demo seeding refused')
    expect(pool.connect).not.toHaveBeenCalled()
  })
})

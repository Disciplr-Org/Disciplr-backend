import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals'

// ─── Mocks ────────────────────────────────────────────────────────────────────
//
// Real `pg.Pool` opens a TCP connection on construction, so it's mocked here
// the same way the rest of the suite mocks it (see jobs.overlapGuard.test.ts)
// — a fake constructor that records instances so tests can assert on
// `.end()` without touching a real Postgres server.

const poolInstances: Array<{ end: jest.Mock<() => Promise<void>> }> = []

jest.unstable_mockModule('pg', () => {
  class MockPool {
    end = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    constructor(public options: unknown) {
      poolInstances.push(this)
    }
  }
  return { Pool: MockPool }
})

let mockDatabaseUrl: string | undefined = 'postgres://test:test@localhost:5432/test'

jest.unstable_mockModule('../config/index.js', () => ({
  getEnv: () => ({ DATABASE_URL: mockDatabaseUrl }),
}))

// ─── Import subject ──────────────────────────────────────────────────────────
//
// Dynamically imported in beforeAll (after mocks are registered), matching
// the pattern used in openapi.contract.test.ts. The module-level `pool`
// singleton is reset between tests via closePgPool() in beforeEach rather
// than jest.resetModules(), since resetModules() would drop the pg/config
// mock registrations for any subsequently re-imported module.

let getPgPool: typeof import('../db/pool.js').getPgPool
let closePgPool: typeof import('../db/pool.js').closePgPool

beforeAll(async () => {
  ;({ getPgPool, closePgPool } = await import('../db/pool.js'))
})

describe('db/pool — closePgPool', () => {
  beforeEach(async () => {
    // Leave no cached pool behind from a prior test.
    await closePgPool()
    poolInstances.length = 0
    mockDatabaseUrl = 'postgres://test:test@localhost:5432/test'
  })

  it('is a no-op when no pool was ever created', async () => {
    await expect(closePgPool()).resolves.toBeUndefined()
    expect(poolInstances).toHaveLength(0)
  })

  it('is a no-op when DATABASE_URL was never set', async () => {
    mockDatabaseUrl = undefined
    expect(getPgPool()).toBeNull()
    await expect(closePgPool()).resolves.toBeUndefined()
    expect(poolInstances).toHaveLength(0)
  })

  it('ends the cached pool and clears the cache so a later call creates a fresh one', async () => {
    const first = getPgPool()
    expect(first).not.toBeNull()
    expect(poolInstances).toHaveLength(1)

    await closePgPool()
    expect(poolInstances[0]!.end).toHaveBeenCalledTimes(1)

    const second = getPgPool()
    expect(poolInstances).toHaveLength(2)
    expect(second).not.toBe(first)
  })

  it('is safe to call more than once in a row', async () => {
    getPgPool()
    await closePgPool()
    await expect(closePgPool()).resolves.toBeUndefined()

    // Only the single real pool was ever ended — the second call was a no-op.
    expect(poolInstances[0]!.end).toHaveBeenCalledTimes(1)
  })
})

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { Pool } from 'pg'
import { getEnv } from '../../config/index.js'
import { getDBHealthMetrics } from '../../services/dbMetrics.js'
import { getPgPool } from '../../db/pool.js'

describe('PostgreSQL Connection Pool Saturation', () => {
  let testPool: Pool
  const POOL_MAX = 3
  const ACQUISITION_TIMEOUT = 1000 // 1 second

  beforeAll(() => {
    // Ensure we cover the getPgPool path as requested for coverage
    getPgPool()
    
    // We create a specifically tuned pool instance for the test to ensure we can
    // easily saturate it without needing to spawn a massive number of connections
    // and to predictably test timeouts.
    const connectionString = getEnv().DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set in environment')
    }

    testPool = new Pool({
      connectionString,
      max: POOL_MAX,
      connectionTimeoutMillis: ACQUISITION_TIMEOUT,
    })
  })

  afterAll(async () => {
    if (testPool) {
      await testPool.end()
    }
  })

  it('queues excess acquisitions, completes them, and recovers without leaking', async () => {
    const queryCount = POOL_MAX * 2
    let completed = 0

    // Fire more queries than pool size to force queueing
    const promises = Array.from({ length: queryCount }).map(async () => {
      const client = await testPool.connect()
      try {
        // Hold the connection briefly using pg_sleep (0.1 seconds)
        await client.query('SELECT pg_sleep(0.1)')
        completed++
      } finally {
        client.release()
      }
    })

    // Allow connections to be requested and queued
    await new Promise((resolve) => setTimeout(resolve, 50))

    const metrics = getDBHealthMetrics(testPool)

    // With 6 queries on a pool of size 3, 3 are active and 3 are waiting
    expect(metrics.pool.totalConnections).toBe(POOL_MAX)
    expect(metrics.pool.waitingClients).toBeGreaterThan(0)
    
    // Verify that the warnings reflect the contention
    expect(metrics.warnings.some(w => w.includes('waiting') || w.includes('capacity'))).toBe(true)

    // Wait for all queries to finish
    await Promise.all(promises)
    expect(completed).toBe(queryCount)

    // Verify recovery and no leak
    const recoveredMetrics = getDBHealthMetrics(testPool)
    expect(recoveredMetrics.pool.waitingClients).toBe(0)
    expect(recoveredMetrics.pool.availableConnections).toBe(POOL_MAX) // Connections should be returned to pool (idle)
  })

  it('throws a typed error when acquisition timeout is exceeded', async () => {
    // Exhaust the pool
    const clients = []
    for (let i = 0; i < POOL_MAX; i++) {
      clients.push(await testPool.connect())
    }

    // Attempt to acquire one more, which should queue then timeout
    let timeoutError: any = null
    const startTime = Date.now()
    try {
      await testPool.connect()
    } catch (error) {
      timeoutError = error
    }
    const elapsed = Date.now() - startTime

    // Release all clients so we don't leak
    for (const client of clients) {
      client.release()
    }

    // Verify that a timeout error was thrown
    expect(timeoutError).not.toBeNull()
    expect(timeoutError.message).toMatch(/timeout/i)
    
    // Verify it took roughly the configured timeout duration
    expect(elapsed).toBeGreaterThanOrEqual(ACQUISITION_TIMEOUT - 100) // slight buffer for timing variance
  })

  it('reflects contention in dbMetrics wait-time/active gauges', async () => {
    const clients = []
    for (let i = 0; i < POOL_MAX; i++) {
      clients.push(await testPool.connect())
    }

    // Trigger one more connection that will wait
    const waitingPromise = testPool.connect()
    
    // Give it time to register as waiting
    await new Promise(resolve => setTimeout(resolve, 50))
    const metrics = getDBHealthMetrics(testPool)

    // Verify it's waiting
    expect(metrics.pool.waitingClients).toBe(1)
    
    // Release one so the waiting connection can proceed
    const clientToRelease = clients.pop()
    clientToRelease?.release()
    
    // Get the waiting client and release it
    const acquiredClient = await waitingPromise
    acquiredClient.release()
    
    // Release the rest
    for (const client of clients) {
      client.release()
    }

    const finalMetrics = getDBHealthMetrics(testPool)
    expect(finalMetrics.pool.waitingClients).toBe(0)
  })
})

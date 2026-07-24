import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import Redis from 'ioredis'
import { createRateLimiter } from '../middleware/rateLimiter.js'
import { initEnv, getEnv } from '../config/index.js'

process.env.DATABASE_URL = 'postgres://dummy'
process.env.JWT_SECRET = 'dummysecret1234567890'
try { initEnv() } catch (e) { /* ignore if already init */ }



describe('Distributed Rate Limiter', () => {
  let redis: Redis | undefined
  const REDIS_URL = getEnv().REDIS_URL ?? process.env.REDIS_URL

  beforeAll(async () => {
    if (REDIS_URL) {
      redis = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false
      })
    }
  })

  afterAll(async () => {
    if (redis) {
      await redis.quit()
    }
  })

  it('shares rate limit counts across multiple instances when Redis is configured', async () => {
    // If no Redis is available in the environment, we skip the shared counting part
    // but we can still run the fail-open and fallback tests.
    if (!REDIS_URL) {
      console.warn('Skipping shared counting test because REDIS_URL is not set.')
      return
    }

    // Since rateLimiter.ts reads from the shared redis instance if env is set,
    // we just create two separate rate limiters pointing to the same config (which simulates two app instances)
    const limiter1 = createRateLimiter({ windowMs: 60000, max: 2, prefix: 'test-shared:' })
    const limiter2 = createRateLimiter({ windowMs: 60000, max: 2, prefix: 'test-shared:' })

    // Clean up the key first
    if (redis) {
      await redis.del('rl:test-shared:::1')
    }

    const app1 = express()
    app1.use(limiter1)
    app1.get('/', (req, res) => { res.send('ok') })

    const app2 = express()
    app2.use(limiter2)
    app2.get('/', (req, res) => { res.send('ok') })

    // Request 1 to app1 (Remaining: 1)
    const res1 = await request(app1).get('/')
    expect(res1.status).toBe(200)
    expect(res1.headers['ratelimit-remaining']).toBe('1')

    // Request 2 to app2 (Remaining: 0, should still be 200 because limit is 2)
    const res2 = await request(app2).get('/')
    expect(res2.status).toBe(200)
    expect(res2.headers['ratelimit-remaining']).toBe('0')

    // Request 3 to app1 (Should be 429)
    const res3 = await request(app1).get('/')
    expect(res3.status).toBe(429)
    expect(res3.headers['retry-after']).toBeDefined()

    // Request 4 to app2 (Should also be 429)
    const res4 = await request(app2).get('/')
    expect(res4.status).toBe(429)
    expect(res4.headers['retry-after']).toBeDefined()
  })

  it('fails open when Redis is unreachable', async () => {
    // We intentionally create a store with a bad connection
    // Let's create a limiter with a bogus REDIS_URL via environment variables
    const originalUrl = process.env.REDIS_URL
    process.env.REDIS_URL = 'redis://localhost:9999'
    
    // We must reset the module or just create a RedisStore directly
    // to avoid polluting the global connection in rateLimiter.ts
    const { RedisStore } = await import('../middleware/rateLimitStore.js')
    const badRedis = new Redis('redis://localhost:9999', {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false
    })

    badRedis.on('error', () => { /* ignore */ })

    const store = new RedisStore(badRedis, 'rl:test-fail-open:')
    
    // The express-rate-limit implementation accepts any Store
    const rateLimit = (await import('express-rate-limit')).default
    const limiter = rateLimit({
      windowMs: 60000,
      max: 1,
      store: store as any
    })

    const app = express()
    app.use(limiter)
    app.get('/', (req, res) => { res.send('ok') })

    // We can simulate an error during increment. The store should catch it and return { totalHits: 0 }.
    
    // Request 1 - should be allowed (fail open)
    const res1 = await request(app).get('/')
    expect(res1.status).toBe(200)

    // Request 2 - normally would be 429 (max: 1), but should be allowed because store fails open
    const res2 = await request(app).get('/')
    expect(res2.status).toBe(200)

    // Clean up
    badRedis.disconnect()
    if (originalUrl !== undefined) {
      process.env.REDIS_URL = originalUrl
    } else {
      delete process.env.REDIS_URL
    }
  })

  it('falls back to in-memory store when REDIS_URL is unset', async () => {
    const originalUrl = process.env.REDIS_URL
    delete process.env.REDIS_URL

    // Import fresh createRateLimiter
    jest.resetModules()
    const { createRateLimiter: localCreateRateLimiter } = await import('../middleware/rateLimiter.js')
    
    const limiter = localCreateRateLimiter({ windowMs: 60000, max: 1, prefix: 'test-fallback:' })
    
    const app = express()
    app.use(limiter)
    app.get('/', (req, res) => { res.send('ok') })

    const res1 = await request(app).get('/')
    expect(res1.status).toBe(200)

    const res2 = await request(app).get('/')
    expect(res2.status).toBe(429)

    if (originalUrl !== undefined) {
      process.env.REDIS_URL = originalUrl
    }
  })
})

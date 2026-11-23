import { describe, it, expect, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { createRateLimiter } from '../middleware/rateLimiter.js'

describe('RateLimit Headers and Retry-After', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    const limiter = createRateLimiter({
      windowMs: 60 * 1000,
      max: 2,
      standardHeaders: 'draft-7',
      keyGenerator: () => 'test-client',
    })

    app.use('/test', limiter, (_req, res) => {
      res.status(200).json({ success: true })
    })
  })

  it('emits RateLimit headers on requests within limit', async () => {
    const res = await request(app).get('/test')
    expect(res.status).toBe(200)
    expect(res.headers).toHaveProperty('ratelimit')
    expect(res.headers['ratelimit']).toMatch(/limit=2/)
  })

  it('emits Retry-After and 429 status code when limit is exceeded', async () => {
    await request(app).get('/test')
    await request(app).get('/test')

    const res = await request(app).get('/test')
    expect(res.status).toBe(429)
    expect(res.headers).toHaveProperty('retry-after')
    const retryAfter = parseInt(res.headers['retry-after'], 10)
    expect(retryAfter).toBeGreaterThanOrEqual(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
  })
})

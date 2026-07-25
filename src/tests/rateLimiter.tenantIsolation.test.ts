import { afterEach, describe, expect, it, jest } from '@jest/globals'
import type { NextFunction, Request, Response } from 'express'
import express from 'express'
import request from 'supertest'
import { createRateLimiter } from '../middleware/rateLimiter.js'

function buildApp(max = 2, windowMs = 60_000) {
  const app = express()
  const limiter = createRateLimiter({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
  })

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const typedReq = req as Request & { orgId?: string }
    typedReq.orgId = (req.headers['x-test-org'] as string | undefined) ?? typedReq.orgId
    req.ip = (req.headers['x-test-ip'] as string | undefined) ?? req.ip ?? '127.0.0.1'
    next()
  })

  app.use(limiter)
  app.get('/test', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  return app
}

describe('rate limiter tenant isolation', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('keeps org-scoped buckets isolated between tenants', async () => {
    const app = buildApp(2, 60_000)

    const first = await request(app)
      .get('/test')
      .set('x-test-org', 'org-a')
      .set('x-test-ip', '198.51.100.10')
      .expect(200)
    expect(first.headers['ratelimit-remaining']).toBe('1')

    const second = await request(app)
      .get('/test')
      .set('x-test-org', 'org-a')
      .set('x-test-ip', '198.51.100.10')
      .expect(200)
    expect(second.headers['ratelimit-remaining']).toBe('0')

    const blocked = await request(app)
      .get('/test')
      .set('x-test-org', 'org-a')
      .set('x-test-ip', '198.51.100.10')
      .expect(429)
    expect(blocked.headers['retry-after']).toBeDefined()
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect(blocked.headers['ratelimit-limit']).toBe('2')
    expect(blocked.headers['ratelimit-remaining']).toBe('0')

    const allowedForOtherOrg = await request(app)
      .get('/test')
      .set('x-test-org', 'org-b')
      .set('x-test-ip', '198.51.100.10')
      .expect(200)
    expect(allowedForOtherOrg.headers['ratelimit-remaining']).toBe('1')
  })

  it('keeps per-IP buckets isolated for a shared org', async () => {
    const app = buildApp(2, 60_000)

    await request(app)
      .get('/test')
      .set('x-test-org', 'shared-org')
      .set('x-test-ip', '203.0.113.5')
      .expect(200)

    await request(app)
      .get('/test')
      .set('x-test-org', 'shared-org')
      .set('x-test-ip', '203.0.113.5')
      .expect(200)

    const blockedForFirstIp = await request(app)
      .get('/test')
      .set('x-test-org', 'shared-org')
      .set('x-test-ip', '203.0.113.5')
      .expect(429)
    expect(blockedForFirstIp.headers['ratelimit-limit']).toBe('2')
    expect(blockedForFirstIp.headers['ratelimit-remaining']).toBe('0')

    const allowedForSecondIp = await request(app)
      .get('/test')
      .set('x-test-org', 'shared-org')
      .set('x-test-ip', '203.0.113.6')
      .expect(200)
    expect(allowedForSecondIp.headers['ratelimit-remaining']).toBe('1')
  })

  it('refills the bucket after the window elapses', async () => {
    jest.useFakeTimers()

    const app = buildApp(2, 1000)

    await request(app)
      .get('/test')
      .set('x-test-org', 'org-c')
      .set('x-test-ip', '198.51.100.20')
      .expect(200)

    await request(app)
      .get('/test')
      .set('x-test-org', 'org-c')
      .set('x-test-ip', '198.51.100.20')
      .expect(200)

    const blocked = await request(app)
      .get('/test')
      .set('x-test-org', 'org-c')
      .set('x-test-ip', '198.51.100.20')
      .expect(429)
    expect(blocked.headers['retry-after']).toBeDefined()

    jest.advanceTimersByTime(1001)

    const recovered = await request(app)
      .get('/test')
      .set('x-test-org', 'org-c')
      .set('x-test-ip', '198.51.100.20')
      .expect(200)
    expect(recovered.headers['ratelimit-remaining']).toBe('1')
  })
})

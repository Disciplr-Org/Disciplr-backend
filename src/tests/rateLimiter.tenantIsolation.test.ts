import { describe, expect, it } from 'bun:test'
import express, { type NextFunction, type Request, type Response } from 'express'
import request, { type Response as SupertestResponse } from 'supertest'
import { createRateLimiter } from '../middleware/rateLimiter.js'

type TenantRequestOptions = {
  orgId?: string
  ip?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function buildRateLimitedApp(options: { max?: number; windowMs?: number } = {}) {
  const app = express()
  const limiter = createRateLimiter({
    windowMs: options.windowMs ?? 1_000,
    max: options.max ?? 2,
    standardHeaders: true,
    legacyHeaders: false,
  })

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const testIp = req.header('x-test-ip')
    if (testIp) {
      Object.defineProperty(req, 'ip', {
        value: testIp,
        configurable: true,
      })
    }

    const orgId = req.header('x-org-id')
    if (orgId) {
      (req as Request & { orgId?: string }).orgId = orgId
    }

    next()
  })

  app.use(limiter)
  app.get('/limited', (req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      orgId: (req as Request & { orgId?: string }).orgId ?? null,
      ip: req.ip,
    })
  })

  return app
}

function limitedGet(app: ReturnType<typeof buildRateLimitedApp>, options: TenantRequestOptions = {}) {
  let req = request(app).get('/limited')
  if (options.orgId) req = req.set('x-org-id', options.orgId)
  if (options.ip) req = req.set('x-test-ip', options.ip)
  return req
}

function expectRateLimitHeaders(response: SupertestResponse, max: number) {
  expect(response.headers['retry-after']).toBeDefined()
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
  expect(response.headers['ratelimit-limit']).toBe(String(max))
  expect(response.headers['ratelimit-remaining']).toBe('0')
  expect(Number(response.headers['ratelimit-reset'])).toBeGreaterThan(0)
}

describe('rate limiter tenant isolation', () => {
  it('keeps organization buckets isolated when tenants share the same IP', async () => {
    const app = buildRateLimitedApp({ max: 2, windowMs: 1_000 })
    const sharedIp = '203.0.113.10'

    await limitedGet(app, { orgId: 'org-a', ip: sharedIp }).expect(200)
    await limitedGet(app, { orgId: 'org-a', ip: sharedIp }).expect(200)
    const orgARejected = await limitedGet(app, { orgId: 'org-a', ip: sharedIp }).expect(429)

    await limitedGet(app, { orgId: 'org-b', ip: sharedIp }).expect(200)
    await limitedGet(app, { orgId: 'org-b', ip: sharedIp }).expect(200)

    expectRateLimitHeaders(orgARejected, 2)
  })

  it('keeps IP buckets isolated when no organization scope is present', async () => {
    const app = buildRateLimitedApp({ max: 2, windowMs: 1_000 })

    await limitedGet(app, { ip: '198.51.100.10' }).expect(200)
    await limitedGet(app, { ip: '198.51.100.10' }).expect(200)
    const noisyIpRejected = await limitedGet(app, { ip: '198.51.100.10' }).expect(429)

    await limitedGet(app, { ip: '198.51.100.20' }).expect(200)
    await limitedGet(app, { ip: '198.51.100.20' }).expect(200)

    expectRateLimitHeaders(noisyIpRejected, 2)
  })

  it('separates organization buckets even when requests use the same API key', async () => {
    const app = buildRateLimitedApp({ max: 1, windowMs: 1_000 })
    const sharedApiKey = 'dsk_shared-test-key'

    await limitedGet(app, { orgId: 'org-a', ip: '203.0.113.30' })
      .set('x-api-key', sharedApiKey)
      .expect(200)
    await limitedGet(app, { orgId: 'org-a', ip: '203.0.113.30' })
      .set('x-api-key', sharedApiKey)
      .expect(429)

    await limitedGet(app, { orgId: 'org-b', ip: '203.0.113.30' })
      .set('x-api-key', sharedApiKey)
      .expect(200)
  })

  it('refills exhausted buckets after the window resets without leaking state to peers', async () => {
    const app = buildRateLimitedApp({ max: 1, windowMs: 120 })
    const sharedIp = '203.0.113.40'

    await limitedGet(app, { orgId: 'org-a', ip: sharedIp }).expect(200)
    const rejected = await limitedGet(app, { orgId: 'org-a', ip: sharedIp }).expect(429)
    expectRateLimitHeaders(rejected, 1)

    await limitedGet(app, { orgId: 'org-b', ip: sharedIp }).expect(200)
    await sleep(180)
    await limitedGet(app, { orgId: 'org-a', ip: sharedIp }).expect(200)
  })
})

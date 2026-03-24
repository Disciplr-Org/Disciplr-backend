import express from 'express'
import { jest } from '@jest/globals'
import request from 'supertest'

const RATE_LIMIT_ENV_KEYS = [
  'ANALYTICS_RATE_LIMIT_WINDOW_MS',
  'ANALYTICS_RATE_LIMIT_MAX',
  'MUTATION_RATE_LIMIT_WINDOW_MS',
  'MUTATION_RATE_LIMIT_MAX',
] as const

const ORIGINAL_ENV = { ...process.env }

const restoreRateLimitEnv = (): void => {
  for (const key of RATE_LIMIT_ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = ORIGINAL_ENV[key]
  }
}

const loadRateLimiterModule = async () => {
  jest.resetModules()
  return import('../src/middleware/rateLimiter.js')
}

describe('rate limiter profiles', () => {
  beforeEach(() => {
    restoreRateLimitEnv()
  })

  afterEach(() => {
    restoreRateLimitEnv()
    jest.restoreAllMocks()
  })

  it('enforces analytics limits from env with a stable 429 payload', async () => {
    process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS = '60000'
    process.env.ANALYTICS_RATE_LIMIT_MAX = '1'
    process.env.MUTATION_RATE_LIMIT_WINDOW_MS = '60000'
    process.env.MUTATION_RATE_LIMIT_MAX = '3'

    const { analyticsRateLimiter } = await loadRateLimiterModule()

    const app = express()
    app.get('/analytics', analyticsRateLimiter, (_req, res) => {
      res.status(200).json({ ok: true })
    })

    const firstResponse = await request(app).get('/analytics')
    const secondResponse = await request(app).get('/analytics')

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(429)
    expect(secondResponse.body).toEqual({
      error: 'Rate limit exceeded. Too many analytics requests. Please try again later.',
      retryAfter: 60,
    })
  })

  it('applies mutation limits only to mutating methods', async () => {
    process.env.MUTATION_RATE_LIMIT_WINDOW_MS = '60000'
    process.env.MUTATION_RATE_LIMIT_MAX = '1'

    const { mutationRateLimiter } = await loadRateLimiterModule()

    const app = express()
    app.use(express.json())
    app.get('/vaults', mutationRateLimiter, (_req, res) => {
      res.status(200).json({ method: 'GET' })
    })
    app.post('/vaults', mutationRateLimiter, (_req, res) => {
      res.status(201).json({ method: 'POST' })
    })

    const getFirst = await request(app).get('/vaults')
    const getSecond = await request(app).get('/vaults')
    const postFirst = await request(app).post('/vaults').send({})
    const postSecond = await request(app).post('/vaults').send({})

    expect(getFirst.status).toBe(200)
    expect(getSecond.status).toBe(200)
    expect(postFirst.status).toBe(201)
    expect(postSecond.status).toBe(429)
    expect(postSecond.body).toEqual({
      error: 'Rate limit exceeded. Too many mutation requests. Please try again later.',
      retryAfter: 60,
    })
  })

  it('tracks analytics and mutation breaches independently', async () => {
    process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS = '60000'
    process.env.ANALYTICS_RATE_LIMIT_MAX = '1'
    process.env.MUTATION_RATE_LIMIT_WINDOW_MS = '60000'
    process.env.MUTATION_RATE_LIMIT_MAX = '2'

    const { analyticsRateLimiter, mutationRateLimiter, getRateLimitMetricsSnapshot } =
      await loadRateLimiterModule()

    const app = express()
    app.use(express.json())
    app.get('/analytics', analyticsRateLimiter, (_req, res) => {
      res.status(200).json({ ok: true })
    })
    app.post('/vaults', mutationRateLimiter, (_req, res) => {
      res.status(201).json({ ok: true })
    })

    await request(app).get('/analytics')
    await request(app).get('/analytics')
    await request(app).post('/vaults').send({})
    await request(app).post('/vaults').send({})
    await request(app).post('/vaults').send({})

    expect(getRateLimitMetricsSnapshot()).toMatchObject({
      analytics: 1,
      mutation: 1,
    })
  })

  it('falls back to safe defaults for invalid env values and avoids logging raw API keys', async () => {
    process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS = 'not-a-number'
    process.env.ANALYTICS_RATE_LIMIT_MAX = '1'

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { analyticsRateLimiter } = await loadRateLimiterModule()

    const app = express()
    app.get('/analytics', analyticsRateLimiter, (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app).get('/analytics').set('x-api-key', 'secret-api-key-value')
    const limitedResponse = await request(app)
      .get('/analytics')
      .set('x-api-key', 'secret-api-key-value')

    expect(limitedResponse.status).toBe(429)
    expect(limitedResponse.body.retryAfter).toBe(900)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    const loggedMessage = String(warnSpy.mock.calls[0][0])
    expect(loggedMessage).toContain('security.rate_limit_triggered')
    expect(loggedMessage).toContain('"identifierSource":"api-key"')
    expect(loggedMessage).not.toContain('secret-api-key-value')
  })
})

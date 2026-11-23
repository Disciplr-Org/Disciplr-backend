/**
 * Issue #1054 – /api/auth rate-limiter throttle test
 *
 * Verifies that repeated POST /login attempts from the same IP are blocked
 * with HTTP 429 once the per-window request budget is exhausted.
 *
 * Strategy: exercise the production auth and account limiters through authRouter.
 * Redis is disabled before importing the router so each limiter uses an
 * in-memory store. All heavy dependencies are mocked to avoid DB/network calls.
 */

import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { notFound } from '../middleware/notFound.js'

// ── Dependency mocks (must be declared before any dynamic import) ──────────────

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}))

jest.unstable_mockModule('../services/auth.service.js', () => ({
  AuthService: {
    register: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
    issueStepUpChallenge: jest.fn(),
    recordStepUpAssertion: jest.fn(),
    registerWebAuthnCredential: jest.fn(),
  },
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../services/session.js', () => ({
  revokeSession: jest.fn(),
  revokeAllUserSessions: jest.fn(),
}))

jest.unstable_mockModule('../middleware/requestBodyLimits.js', () => ({
  AUTH_JSON_MAX_BYTES: 16_384,
}))

// ── Module imports (after mocks) ──────────────────────────────────────────────

const originalRedisUrl = process.env.REDIS_URL
delete process.env.REDIS_URL

const { authRouter } = await import('../routes/auth.js')
const { AuthService } = await import('../services/auth.service.js')
const mockLogin = jest.mocked(AuthService.login)

afterAll(() => {
  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL
  } else {
    process.env.REDIS_URL = originalRedisUrl
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Each test uses a distinct forwarded IP so the production auth limiter's
 * shared in-memory store remains isolated between tests.
 */
function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(notFound)
  app.use(errorHandler)
  return app
}

function postLogin(app: ReturnType<typeof buildApp>, ip: string, email: string) {
  return request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: 'password123' })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login – rate-limiter throttle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogin.mockReset().mockResolvedValue({ token: 'mock-token' })
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('allows requests up to the limit and then returns 429', async () => {
    const MAX = 20
    const app = buildApp()
    const ip = '192.0.2.10'

    // Requests 1–MAX should all pass through to the mocked successful login.
    for (let i = 0; i < MAX; i++) {
      const res = await postLogin(app, ip, `user${i}@example.com`)

      expect(res.status).toBe(200)
    }

    // Request MAX+1 must be blocked by the rate limiter.
    const throttled = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'attacker@example.com', password: 'password123' })

    expect(throttled.status).toBe(429)
  })

  it('sets the standard RateLimit header with the per-account remaining budget', async () => {
    const app = buildApp()

    const first = await postLogin(app, '192.0.2.11', 'user@example.com')

    const rateLimit = first.headers.ratelimit
    expect(rateLimit).toMatch(/limit=5/)
    expect(rateLimit).toMatch(/remaining=4/)
  })

  it('returns 429 for /register as well (same limiter covers whole /api/auth prefix)', async () => {
    const MAX = 20
    const app = buildApp()
    const ip = '192.0.2.12'

    // Exhaust budget on /login
    for (let i = 0; i < MAX; i++) {
      const res = await postLogin(app, ip, `user${i}@example.com`)
      expect(res.status).toBe(200)
    }

    // /register should also be blocked — same IP budget
    const throttled = await request(app)
      .post('/api/auth/register')
      .set('X-Forwarded-For', ip)
      .send({ email: 'new@example.com', password: 'password123' })

    expect(throttled.status).toBe(429)
  })

  it('limits failed login attempts per account', async () => {
    const app = buildApp()
    const ip = '192.0.2.13'
    const email = 'target@example.com'
    mockLogin.mockRejectedValue(new Error('Invalid credentials'))

    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await postLogin(app, ip, email)
      expect(res.status).toBe(401)
    }

    const throttled = await postLogin(app, ip, email)
    expect(throttled.status).toBe(429)
  })
})

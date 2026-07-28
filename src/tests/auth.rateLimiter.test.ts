/**
 * Issue #1054 – /api/auth rate-limiter throttle test
 *
 * Verifies that repeated POST /login attempts from the same IP are blocked
 * with HTTP 429 once the per-window request budget is exhausted.
 *
 * Strategy: mount authRouter behind a fresh, tight express-rate-limit instance
 * (max: 3) instead of the production singleton so the test is self-contained
 * and deterministic.  All heavy dependencies (prisma, auth service, audit logs,
 * session, stepUp, auth middleware) are mocked so no DB or network calls occur.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'

// ── Dependency mocks (must be declared before any dynamic import) ──────────────

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: jest.fn<any>(),
      update: jest.fn<any>(),
    },
  },
}))

jest.unstable_mockModule('../services/auth.service.js', () => ({
  AuthService: {
    register: jest.fn<any>(),
    login: jest.fn<any>().mockResolvedValue({ token: 'mock-token' }),
    refresh: jest.fn<any>(),
    logout: jest.fn<any>(),
    issueStepUpChallenge: jest.fn<any>(),
    recordStepUpAssertion: jest.fn<any>(),
    registerWebAuthnCredential: jest.fn<any>(),
  },
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn<any>().mockResolvedValue({ id: 'audit-1' }),
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../services/session.js', () => ({
  revokeSession: jest.fn<any>(),
  revokeAllUserSessions: jest.fn<any>(),
}))

jest.unstable_mockModule('../middleware/requestBodyLimits.js', () => ({
  AUTH_JSON_MAX_BYTES: 16_384,
}))

// ── Module imports (after mocks) ──────────────────────────────────────────────

const { authRouter } = await import('../routes/auth.js')
const { default: rateLimit } = await import('express-rate-limit')
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { notFound } from '../middleware/notFound.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express app that wraps authRouter behind a fresh
 * rate-limit instance with the given `max` budget.
 * A new limiter is created per call so each test gets an isolated counter.
 */
function buildApp(max: number) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Use a fixed key so all test requests share the same bucket
    keyGenerator: () => 'test-ip',
  })

  const app = express()
  app.use(express.json())
  app.use('/api/auth', limiter, authRouter)
  app.use(notFound)
  app.use(errorHandler)
  return app
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login – rate-limiter throttle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('allows requests up to the limit and then returns 429', async () => {
    const MAX = 3
    const app = buildApp(MAX)

    // Requests 1–MAX should all pass through (may succeed or fail for auth
    // reasons, but must NOT be 429).
    for (let i = 0; i < MAX; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: `user${i}@example.com`, password: 'password123' })

      expect(res.status).not.toBe(429)
    }

    // Request MAX+1 must be blocked by the rate limiter.
    const throttled = await request(app)
      .post('/api/auth/login')
      .send({ email: 'attacker@example.com', password: 'password123' })

    expect(throttled.status).toBe(429)
  })

  it('sets RateLimit-Remaining header that decrements with each request', async () => {
    const MAX = 5
    const app = buildApp(MAX)

    const first = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'password123' })

    const remaining = Number(first.headers['ratelimit-remaining'])
    expect(remaining).toBe(MAX - 1)
  })

  it('returns 429 for /register as well (same limiter covers whole /api/auth prefix)', async () => {
    const MAX = 2
    const app = buildApp(MAX)

    // Exhaust budget on /login
    for (let i = 0; i < MAX; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: `u${i}@example.com`, password: 'pw' })
    }

    // /register should also be blocked — same IP budget
    const throttled = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', password: 'password123' })

    expect(throttled.status).toBe(429)
  })
})

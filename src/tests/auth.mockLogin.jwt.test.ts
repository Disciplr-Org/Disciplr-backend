/**
 * auth.mockLogin.jwt.test.ts
 *
 * Issue #1842 – the userId-only (mock) login must issue a usable token.
 *
 * Asserts that:
 *   1. the returned `token` is a real signed JWT carrying userId + role,
 *   2. it authenticates against an `authenticate`-protected route
 *      (GET /api/vaults is the route named in the issue),
 *   3. the `auth.mock_login_used` audit entry is preserved,
 *   4. the token is short-lived.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import express from 'express'
import request from 'supertest'

// Environment must be configured before the route/env modules load.
const TEST_SECRET = 'test-mock-login-secret-at-least-32-chars!'
process.env.NODE_ENV = 'test'
process.env.ENABLE_MOCK_LOGIN = 'true'
process.env.JWT_SECRET = TEST_SECRET
process.env.JWT_ACCESS_SECRET = TEST_SECRET
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-chars!!'
process.env.DOWNLOAD_SECRET ??= 'test-download-secret-at-least-16-chars'

const USER_ID = '22222222-2222-4222-8222-222222222222'

const mockUserUpdate = jest.fn<any>()
const mockCreateAuditLog = jest.fn<any>()
const mockRecordSession = jest.fn<any>()
const mockValidateSession = jest.fn<any>()

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    user: {
      update: mockUserUpdate,
    },
  },
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

jest.unstable_mockModule('../services/session.js', () => ({
  recordSession: mockRecordSession,
  validateSession: mockValidateSession,
  revokeSession: jest.fn<any>(),
  revokeAllUserSessions: jest.fn<any>(),
}))

// ── Dynamic imports (after all mocks) ────────────────────────────────────────

const { authRouter } = await import('../routes/auth.js')
const { authenticate } = await import('../middleware/auth.js')
const { verifyAccessToken } = await import('../lib/auth-utils.js')
const { errorHandler } = await import('../middleware/errorHandler.js')
const { UserRole } = await import('../types/user.js')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  // Minimal stand-in for GET /api/vaults: the real route is guarded by the
  // same `authenticate` middleware, so a 200 here proves the token is accepted.
  app.get('/api/vaults', authenticate, (req: Request, res: Response) => {
    res.json({ userId: (req as any).user.userId })
  })
  app.use(errorHandler)
  return app
}

beforeEach(() => {
  mockUserUpdate.mockResolvedValue({
    id: USER_ID,
    role: UserRole.USER,
    lastLoginAt: new Date(),
  })
  mockCreateAuditLog.mockResolvedValue({ id: 'audit-1' })
  mockRecordSession.mockResolvedValue(undefined)
  mockValidateSession.mockResolvedValue(true)
  mockUserUpdate.mockClear()
  mockCreateAuditLog.mockClear()
  mockRecordSession.mockClear()
})

describe('POST /api/auth/login – userId-only mock login issues a real JWT (#1842)', () => {
  it('returns a signed JWT instead of an opaque mock-token string', async () => {
    const res = await request(buildApp()).post('/api/auth/login').send({ userId: USER_ID })

    expect(res.status).toBe(200)
    expect(typeof res.body.token).toBe('string')
    expect(res.body.token).not.toMatch(/^mock-token-/)
    expect(res.body.token.split('.')).toHaveLength(3)

    const payload = verifyAccessToken(res.body.token)
    expect(payload).toMatchObject({ userId: USER_ID, role: UserRole.USER })
  })

  it('issues a short-lived token (15 minutes)', async () => {
    const res = await request(buildApp()).post('/api/auth/login').send({ userId: USER_ID })

    const decoded = verifyAccessToken(res.body.token) as { iat: number; exp: number }
    expect(decoded.exp - decoded.iat).toBe(15 * 60)
  })

  it('records a revocable session for the token jti', async () => {
    const res = await request(buildApp()).post('/api/auth/login').send({ userId: USER_ID })

    const payload = verifyAccessToken(res.body.token) as { jti?: string }
    expect(payload.jti).toBeTruthy()
    expect(mockRecordSession).toHaveBeenCalledWith(USER_ID, payload.jti, expect.any(Date))
  })

  it('authenticates against GET /api/vaults', async () => {
    const app = buildApp()
    const login = await request(app).post('/api/auth/login').send({ userId: USER_ID })

    const res = await request(app)
      .get('/api/vaults')
      .set('Authorization', `Bearer ${login.body.token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: USER_ID })
    expect(mockValidateSession).toHaveBeenCalledWith(expect.any(String))
  })

  it('preserves the auth.mock_login_used audit entry', async () => {
    const res = await request(buildApp()).post('/api/auth/login').send({ userId: USER_ID })

    expect(res.status).toBe(200)
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: USER_ID,
        action: 'auth.mock_login_used',
        target_type: 'user',
        target_id: USER_ID,
      }),
    )
  })

  it('rejects the token when its session is revoked', async () => {
    const app = buildApp()
    const login = await request(app).post('/api/auth/login').send({ userId: USER_ID })

    mockValidateSession.mockResolvedValueOnce(false)

    const res = await request(app)
      .get('/api/vaults')
      .set('Authorization', `Bearer ${login.body.token}`)

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized: Session revoked or expired')
  })
})

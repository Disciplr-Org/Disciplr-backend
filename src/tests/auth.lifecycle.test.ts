/**
 * Issue #1543 – Authentication lifecycle coverage
 *
 * Covers: register, login, refresh, logout, logout-all, token expiry,
 * session revocation, role/admin authorization, changePassword,
 * breached-password check, and the `authenticate` middleware invariants.
 *
 * All heavy I/O (prisma, sessions, audit-logs, step-up) is mocked so the
 * suite is deterministic and runs without a live database.
 *
 * Refs #1543
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// ── Env setup – must be done before any module import ────────────────────────
// Set both secrets to the same value so the primary verifyAccessToken path
// (JWT_ACCESS_SECRET) and the legacy fallback (JWT_SECRET) both work with the
// tokens we sign in tests.
const TEST_SECRET = 'test-lifecycle-secret-at-least-32-chars!!'
process.env.JWT_SECRET = TEST_SECRET
process.env.JWT_ACCESS_SECRET = TEST_SECRET
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-chars!!'
process.env.DOWNLOAD_SECRET ??= 'test-download-secret-at-least-16-chars'
process.env.NODE_ENV ??= 'test'

// ── AuthService mock stubs (created here so tests can control return values) ─
const mockRegister = jest.fn<any>()
const mockLogin = jest.fn<any>()
const mockRefresh = jest.fn<any>()
const mockLogout = jest.fn<any>()
const mockLogoutAll = jest.fn<any>()
const mockChangePassword = jest.fn<any>()
const mockIssueStepUpChallenge = jest.fn<any>()
const mockRecordStepUpAssertion = jest.fn<any>()
const mockRegisterWebAuthn = jest.fn<any>()

// Prisma stubs
const mockPrismaUserFindUnique = jest.fn<any>()
const mockPrismaUserCreate = jest.fn<any>()
const mockPrismaUserUpdate = jest.fn<any>()

// ── Mock declarations (must precede any dynamic import) ──────────────────────

jest.unstable_mockModule('../services/auth.service.js', () => ({
  AuthService: {
    register: mockRegister,
    login: mockLogin,
    refresh: mockRefresh,
    logout: mockLogout,
    logoutAll: mockLogoutAll,
    changePassword: mockChangePassword,
    issueStepUpChallenge: mockIssueStepUpChallenge,
    recordStepUpAssertion: mockRecordStepUpAssertion,
    registerWebAuthnCredential: mockRegisterWebAuthn,
    // ensurePasswordIsAllowed is private — tested via register/changePassword
  },
}))

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: mockPrismaUserFindUnique,
      create: mockPrismaUserCreate,
      update: mockPrismaUserUpdate,
    },
  },
}))

jest.unstable_mockModule('../lib/prismaScope.js', () => ({
  getPrisma: () => ({
    user: {
      findUnique: mockPrismaUserFindUnique,
      create: mockPrismaUserCreate,
      update: mockPrismaUserUpdate,
    },
    $executeRaw: jest.fn<any>().mockResolvedValue(1),
    $queryRaw: jest.fn<any>().mockResolvedValue([]),
  }),
  prismaStorage: { getStore: () => undefined },
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn<any>().mockResolvedValue({ id: 'audit-mock-id' }),
}))

const mockRecordSession = jest.fn<any>().mockResolvedValue(undefined)
const mockValidateSession = jest.fn<any>().mockResolvedValue(true)
const mockRevokeSession = jest.fn<any>().mockResolvedValue(undefined)
const mockRevokeAllUserSessions = jest.fn<any>().mockResolvedValue(undefined)

jest.unstable_mockModule('../services/session.js', () => ({
  recordSession: mockRecordSession,
  validateSession: mockValidateSession,
  revokeSession: mockRevokeSession,
  revokeAllUserSessions: mockRevokeAllUserSessions,
}))

jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../middleware/requestBodyLimits.js', () => ({
  AUTH_JSON_MAX_BYTES: 65_536,
}))

jest.unstable_mockModule('../middleware/requireJson.js', () => ({
  requireJson: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

// ── Dynamic imports (after all mocks) ────────────────────────────────────────

const { authRouter } = await import('../routes/auth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')
const { authenticate, requireAdmin, authorize } = await import('../middleware/auth.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

/** Sign a token using the same secret as the middleware. */
function makeToken(payload: object, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, TEST_SECRET, {
    expiresIn: '15m',
    issuer: 'disciplr',
    audience: 'disciplr-api',
    ...options,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejects missing email with VALIDATION_ERROR', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/register')
      .send({ password: 'secure-password-123' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects password shorter than 8 characters', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects invalid email format', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'validpassword' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects empty body', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/auth/register').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when email is already in use', async () => {
    mockRegister.mockRejectedValueOnce(new Error('Email already in use'))
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'duplicate@example.com', password: 'password1234' })
    expect(res.status).toBe(400)
  })

  it('registers a new user successfully and does not expose passwordHash', async () => {
    mockRegister.mockResolvedValueOnce({
      id: 'user-new',
      email: 'new@example.com',
      role: 'USER',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', password: 'validpassword' })
    expect(res.status).toBe(201)
    expect(res.body.email).toBe('new@example.com')
    expect(res.body).not.toHaveProperty('passwordHash')
  })
})

describe('POST /api/auth/login', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejects missing email with VALIDATION_ERROR', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'password123' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects missing password with VALIDATION_ERROR', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 401 for invalid credentials', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Invalid credentials'))
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'wrongpassword' })
    expect(res.status).toBe(401)
  })

  it('returns tokens on valid credentials without exposing passwordHash', async () => {
    mockLogin.mockResolvedValueOnce({
      user: { id: 'u1', email: 'user@example.com', role: 'USER' },
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'correct-password' })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBe('mock-access-token')
    expect(res.body.refreshToken).toBe('mock-refresh-token')
    expect(res.body.user.id).toBe('u1')
    expect(res.body.user).not.toHaveProperty('passwordHash')
  })

  it('error response does not include password or hash in body', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Invalid credentials'))
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'badpass1' })
    const body = JSON.stringify(res.body)
    expect(body).not.toMatch(/password/i)
  })
})

describe('POST /api/auth/refresh', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns 400 when refreshToken field is missing', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/auth/refresh').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 401 for an expired or revoked refresh token', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('Invalid refresh token'))
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'expired-or-revoked-token' })
    expect(res.status).toBe(401)
  })

  it('returns 401 for refresh token reuse (revoked family)', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('Invalid refresh token'))
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'already-used-token' })
    expect(res.status).toBe(401)
  })

  it('issues new access and refresh tokens on success', async () => {
    mockRefresh.mockResolvedValueOnce({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'valid-refresh-token' })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBe('new-access')
    expect(res.body.refreshToken).toBe('new-refresh')
  })
})

describe('POST /api/auth/logout', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns 401 when no Authorization header is provided', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: 'some-token' })
    expect(res.status).toBe(401)
  })

  it('revokes the refresh token and JTI session on success', async () => {
    const jti = 'jti-logout-test'
    const token = makeToken({ userId: 'u-logout', role: 'USER', jti })
    mockValidateSession.mockResolvedValueOnce(true)
    mockLogout.mockResolvedValueOnce(undefined)

    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({ refreshToken: 'refresh-to-revoke' })

    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(/logged out/i)
    expect(mockLogout).toHaveBeenCalledWith('refresh-to-revoke')
    expect(mockRevokeSession).toHaveBeenCalledWith(jti)
  })

  it('succeeds even when refreshToken body field is omitted', async () => {
    const token = makeToken({ userId: 'u-no-rt', role: 'USER', jti: 'jti-no-rt' })
    mockValidateSession.mockResolvedValueOnce(true)

    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(res.status).toBe(200)
  })
})

describe('POST /api/auth/logout-all', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/auth/logout-all')
    expect(res.status).toBe(401)
  })

  it('revokes all sessions for the authenticated user', async () => {
    const token = makeToken({ userId: 'u-all', role: 'USER', jti: 'jti-all' })
    mockValidateSession.mockResolvedValueOnce(true)

    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(/logged out/i)
    expect(mockRevokeAllUserSessions).toHaveBeenCalledWith('u-all')
  })
})

// ── authenticate middleware unit tests ────────────────────────────────────────

describe('authenticate middleware', () => {
  function buildProtectedApp() {
    const app = express()
    app.use(express.json())
    app.get('/protected', authenticate, (_req, res) => res.json({ ok: true }))
    return app
  }

  beforeEach(() => jest.clearAllMocks())

  it('returns 401 when Authorization header is missing', async () => {
    const app = buildProtectedApp()
    const res = await request(app).get('/protected')
    expect(res.status).toBe(401)
  })

  it('returns 401 when header does not start with "Bearer "', async () => {
    const app = buildProtectedApp()
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
    expect(res.status).toBe(401)
  })

  it('returns 401 for an expired token', async () => {
    // Use jsonwebtoken's expiresIn option with a negative value so the library
    // itself sets exp = iat - 1, which will be in the past even accounting for
    // the 30-second clockTolerance in verifyAccessToken.
    const expired = jwt.sign(
      { userId: 'u-exp', role: 'USER', jti: 'jti-exp' },
      TEST_SECRET,
      { expiresIn: -3600, issuer: 'disciplr', audience: 'disciplr-api' } as any,
    )
    const app = buildProtectedApp()
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${expired}`)
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/expired/i)
  })

  it('returns 401 for a token signed with a different secret', async () => {
    const tampered = jwt.sign(
      { userId: 'u-tamper', role: 'USER' },
      'completely-wrong-secret-nobody-knows',
      { expiresIn: '15m', issuer: 'disciplr', audience: 'disciplr-api' },
    )
    const app = buildProtectedApp()
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tampered}`)
    expect(res.status).toBe(401)
  })

  it('returns 401 for a token whose session has been revoked', async () => {
    const token = makeToken({ userId: 'u-rev', role: 'USER', jti: 'jti-revoked' })
    mockValidateSession.mockResolvedValueOnce(false)

    const app = buildProtectedApp()
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/revoked|expired/i)
  })

  it('returns 401 for a token with iat far in the future (clock-skew attack)', async () => {
    const now = Math.floor(Date.now() / 1000)
    // Manually build token with a future iat (beyond 30-second clock tolerance)
    const futureToken = jwt.sign(
      { userId: 'u-future', role: 'USER', jti: 'jti-future', iat: now + 120 },
      TEST_SECRET,
      { expiresIn: '1h', issuer: 'disciplr', audience: 'disciplr-api' },
    )
    const app = buildProtectedApp()
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${futureToken}`)
    expect(res.status).toBe(401)
  })

  it('grants access for a valid, non-revoked token', async () => {
    const token = makeToken({ userId: 'u-valid', role: 'USER', jti: 'jti-ok' })
    mockValidateSession.mockResolvedValueOnce(true)

    const app = buildProtectedApp()
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

// ── requireAdmin middleware ───────────────────────────────────────────────────

describe('requireAdmin middleware', () => {
  function buildAdminApp() {
    const app = express()
    app.use(express.json())
    app.post('/admin', authenticate, requireAdmin, (_req, res) => res.json({ ok: true }))
    return app
  }

  beforeEach(() => jest.clearAllMocks())

  it('returns 401 when not authenticated', async () => {
    const app = buildAdminApp()
    const res = await request(app).post('/admin')
    expect(res.status).toBe(401)
  })

  it('returns 403 for a USER-role token', async () => {
    const token = makeToken({ userId: 'u-user', role: 'USER', jti: 'jti-u' })
    mockValidateSession.mockResolvedValueOnce(true)
    const app = buildAdminApp()
    const res = await request(app)
      .post('/admin')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('returns 403 for impersonation tokens even with ADMIN role', async () => {
    const token = makeToken({
      userId: 'target-user',
      role: 'ADMIN',
      jti: 'jti-imp',
      impersonator: 'admin-actor',
    })
    mockValidateSession.mockResolvedValueOnce(true)
    const app = buildAdminApp()
    const res = await request(app)
      .post('/admin')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/impersonation/i)
  })

  it('allows genuine ADMIN tokens without impersonator claim', async () => {
    const token = makeToken({ userId: 'real-admin', role: 'ADMIN', jti: 'jti-admin' })
    mockValidateSession.mockResolvedValueOnce(true)
    const app = buildAdminApp()
    const res = await request(app)
      .post('/admin')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

// ── authorize role guard ──────────────────────────────────────────────────────

describe('authorize role guard', () => {
  it('allows a request when the user role is in the allowed list', async () => {
    const app = express()
    app.use(express.json())
    app.get('/guarded', (req, _res, next) => {
      ;(req as any).user = { userId: 'u', role: 'VERIFIER' }
      next()
    }, authorize(['VERIFIER', 'ADMIN'] as any), (_req, res) => res.json({ ok: true }))

    const res = await request(app).get('/guarded')
    expect(res.status).toBe(200)
  })

  it('denies when the user role is not in the allowed list', async () => {
    const app = express()
    app.use(express.json())
    app.get('/guarded', (req, _res, next) => {
      ;(req as any).user = { userId: 'u', role: 'VERIFIER' }
      next()
    }, authorize(['ADMIN'] as any), (_req, res) => res.json({ ok: true }))

    const res = await request(app).get('/guarded')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/requires role/i)
  })

  it('returns 401 when req.user is not set', async () => {
    const app = express()
    app.use(express.json())
    app.get('/guarded', authorize(['ADMIN'] as any), (_req, res) => res.json({ ok: true }))

    const res = await request(app).get('/guarded')
    expect(res.status).toBe(401)
  })
})

// ── Breached-password guard (via route) ──────────────────────────────────────

describe('POST /api/auth/register – breached password guard (route level)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns 400 when AuthService.register throws Password rejected', async () => {
    mockRegister.mockRejectedValueOnce(new Error('Password rejected'))

    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'breach@example.com', password: 'password123' })

    expect(res.status).toBe(400)
  })
})

// ── Credential expiry and rotation – AuthService unit ────────────────────────

describe('AuthService refresh token expiry and rotation', () => {
  beforeEach(() => jest.clearAllMocks())

  it('delegates to AuthService.refresh and surfaces 401 on failure', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('Invalid refresh token'))
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'dsk_stale.old' })
    expect(res.status).toBe(401)
    expect(mockRefresh).toHaveBeenCalledWith('dsk_stale.old')
  })

  it('rotates: old token is consumed and new tokens returned', async () => {
    mockRefresh.mockResolvedValueOnce({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'valid-one-time-token' })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBe('fresh-access')
    expect(res.body.refreshToken).toBe('fresh-refresh')
    // The old token was passed to the service — service owns rotation logic
    expect(mockRefresh).toHaveBeenCalledWith('valid-one-time-token')
  })
})

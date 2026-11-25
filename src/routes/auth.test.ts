// Jest ESM requires jest.unstable_mockModule() before dynamically importing modules under test.
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>

const mockAuthService: Record<string, AsyncMock> = {
  register: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  login: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  refresh: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  logout: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  issueStepUpChallenge: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  recordStepUpAssertion: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  registerWebAuthnCredential: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  verifyStepUpAssertion: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
}

const mockPrismaUser = {
  findUnique: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  update: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  updateMany: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
}

const mockPrisma = {
  user: mockPrismaUser,
  $transaction: jest.fn<(cb: (tx: { user: typeof mockPrismaUser }) => Promise<unknown>) => Promise<unknown>>(
    async (cb) => cb({ user: mockPrismaUser }),
  ),
}

const mockCreateAuditLog = jest
  .fn<(...args: unknown[]) => Promise<{ id: string }>>()
  .mockResolvedValue({ id: 'audit-log-id' })

const mockAuthenticate = jest.fn<(req: Request, res: Response, next: NextFunction) => void>(
  (req, _res, next) => {
    ;(req as Request & { user?: { userId: string; role: string; jti: string } }).user = {
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'ADMIN',
      jti: 'jti-1',
    }
    next()
  },
)

const mockRequireStepUp = jest.fn<() => (req: Request, res: Response, next: NextFunction) => void>(
  () => (_req, _res, next) => next(),
)

const mockRevokeSession = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const mockRevokeAllUserSessions = jest
  .fn<(...args: unknown[]) => Promise<void>>()
  .mockResolvedValue(undefined)

const mockAuthRateLimiter = jest.fn<(req: Request, res: Response, next: NextFunction) => void>(
  (_req, _res, next) => next(),
)

jest.unstable_mockModule('../services/auth.service.js', () => ({
  AuthService: mockAuthService,
}))

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: mockPrisma,
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: mockAuthenticate,
}))

jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: mockRequireStepUp,
}))

jest.unstable_mockModule('../services/session.js', () => ({
  revokeSession: mockRevokeSession,
  revokeAllUserSessions: mockRevokeAllUserSessions,
  recordSession: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  authRateLimiter: mockAuthRateLimiter,
  accountLoginLimiter: mockAuthRateLimiter,
}))

const { authRouter } = await import('./auth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

const createApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

describe('authRouter request validation and route handlers', () => {
  let app: express.Express

  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateAuditLog.mockResolvedValue({ id: 'audit-log-id' })
    mockRevokeSession.mockResolvedValue(undefined)
    mockRevokeAllUserSessions.mockResolvedValue(undefined)
    mockAuthenticate.mockImplementation((req, _res, next) => {
      ;(req as Request & { user?: { userId: string; role: string; jti: string } }).user = {
        userId: '11111111-1111-4111-8111-111111111111',
        role: 'ADMIN',
        jti: 'jti-1',
      }
      next()
    })
    app = createApp()
  })

  describe('POST /api/auth/register', () => {
    it('returns 400 when registration payload fails validation', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: '123' })

      expect(res.status).toBe(400)
      expect(mockAuthService.register).not.toHaveBeenCalled()
    })

    it('returns 201 and delegates to AuthService.register for valid input', async () => {
      const created = { id: 'user-1', email: 'user@example.com' }
      mockAuthService.register.mockResolvedValue(created)

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'user@example.com', password: 'StrongPassword123!' })

      expect(res.status).toBe(201)
      expect(res.body).toEqual(created)
      expect(mockAuthService.register).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'StrongPassword123!',
      })
    })
  })

  describe('POST /api/auth/login', () => {
    it('returns 400 when credential login payload fails validation', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'invalid-email' })

      expect(res.status).toBe(400)
      expect(mockAuthService.login).not.toHaveBeenCalled()
    })

    it('returns 400 when userId-only login has a non-UUID userId', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ userId: 'not-a-uuid' })

      expect(res.status).toBe(400)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('returns 200 for valid credential login', async () => {
      const session = { accessToken: 'access-1', refreshToken: 'refresh-1' }
      mockAuthService.login.mockResolvedValue(session)

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'user@example.com', password: 'StrongPassword123!' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual(session)
      expect(mockAuthService.login).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'StrongPassword123!',
      })
    })
  })

  describe('POST /api/auth/refresh', () => {
    it('returns 400 when refreshToken is missing', async () => {
      const res = await request(app).post('/api/auth/refresh').send({})

      expect(res.status).toBe(400)
      expect(mockAuthService.refresh).not.toHaveBeenCalled()
    })

    it('returns 200 when refreshToken is valid', async () => {
      mockAuthService.refresh.mockResolvedValue({ accessToken: 'new-access' })

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'valid-refresh-token' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ accessToken: 'new-access' })
      expect(mockAuthService.refresh).toHaveBeenCalledWith('valid-refresh-token')
    })
  })

  describe('POST /api/auth/logout', () => {
    it('returns 400 when refreshToken is an empty string', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .send({ refreshToken: '' })

      expect(res.status).toBe(400)
      expect(mockAuthService.logout).not.toHaveBeenCalled()
    })

    it('revokes refreshToken and current session jti on logout', async () => {
      mockAuthService.logout.mockResolvedValue(undefined)

      const res = await request(app)
        .post('/api/auth/logout')
        .send({ refreshToken: 'refresh-token-1' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ message: 'Successfully logged out' })
      expect(mockAuthService.logout).toHaveBeenCalledWith('refresh-token-1')
      expect(mockRevokeSession).toHaveBeenCalledWith('jti-1')
    })
  })

  describe('POST /api/auth/logout-all', () => {
    it('revokes all sessions for the authenticated user', async () => {
      const res = await request(app).post('/api/auth/logout-all')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ message: 'Successfully logged out from all devices' })
      expect(mockRevokeAllUserSessions).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
      )
    })
  })

  describe('POST /api/auth/webauthn/assert', () => {
    const validBody = {
      nonce: '22222222-2222-4222-8222-222222222222',
      credentialId: 'valid_credential_id_1234',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
      authenticatorData: 'YXV0aGVudGljYXRvcl9kYXRh',
      signature: 'c2lnbmF0dXJl',
    }

    it('returns 400 when required WebAuthn fields are missing', async () => {
      const res = await request(app)
        .post('/api/auth/webauthn/assert')
        .send({ nonce: validBody.nonce })

      expect(res.status).toBe(400)
      expect(mockAuthService.verifyStepUpAssertion).not.toHaveBeenCalled()
    })

    it('returns 400 when nonce is not a valid UUID', async () => {
      const res = await request(app)
        .post('/api/auth/webauthn/assert')
        .send({ ...validBody, nonce: 'not-a-uuid' })

      expect(res.status).toBe(400)
      expect(mockAuthService.verifyStepUpAssertion).not.toHaveBeenCalled()
    })

    it('verifies the assertion and returns a step-up session id', async () => {
      mockAuthService.verifyStepUpAssertion.mockResolvedValue({ stepUpSessionId: 'step-up-session-1' })

      const res = await request(app)
        .post('/api/auth/webauthn/assert')
        .send(validBody)

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, stepUpSessionId: 'step-up-session-1' })
      expect(mockAuthService.verifyStepUpAssertion).toHaveBeenCalledWith({
        ...validBody,
        userId: '11111111-1111-4111-8111-111111111111',
      })
      expect(mockAuthService.registerWebAuthnCredential).not.toHaveBeenCalled()
    })

    it('returns 401 when the assertion cannot be verified', async () => {
      mockAuthService.verifyStepUpAssertion.mockResolvedValue({
        stepUpSessionId: null,
        reason: 'Invalid signature',
      })

      const res = await request(app)
        .post('/api/auth/webauthn/assert')
        .send(validBody)

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })
  })

  describe('POST /api/auth/users/:id/role', () => {
    it('returns 400 when :id param is not a valid UUID', async () => {
      const res = await request(app)
        .post('/api/auth/users/not-a-uuid/role')
        .send({ role: 'USER' })

      expect(res.status).toBe(400)
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    })

    it('returns 400 when role body is invalid', async () => {
      const res = await request(app)
        .post('/api/auth/users/22222222-2222-4222-8222-222222222222/role')
        .send({ role: 'SUPER_INVALID_ROLE' })

      expect(res.status).toBe(400)
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    })
  })
})

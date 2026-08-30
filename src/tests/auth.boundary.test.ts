import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { UserRole } from '../types/user.js'

// ── Module mocks (jest.unstable_mockModule, must precede the imports) ────────

type PersistedUser = {
  id: string
  email: string
  role: UserRole
  status?: string
  deletedAt?: Date | null
  lastLoginAt: Date | null
}

const mockUsers = new Map<string, PersistedUser>()

const cloneSelectedUser = (
  user: PersistedUser | null | undefined,
  select?: Record<string, boolean>,
): Record<string, unknown> | null => {
  if (!user) return null
  if (!select) return { ...user }
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, include]) => include)
      .map(([key]) => [key, user[key as keyof PersistedUser]]),
  )
}

const mockPrisma = {
  user: {
    findUnique: jest.fn(async ({ where, select }: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) => {
      const user = where.id
        ? mockUsers.get(where.id)
        : Array.from(mockUsers.values()).find((entry) => entry.email === where.email)
      return cloneSelectedUser(user, select)
    }),
    update: jest.fn(async ({ where, data, select }: { where: { id: string }; data: Partial<PersistedUser>; select?: Record<string, boolean> }) => {
      const existing = mockUsers.get(where.id)
      if (!existing) throw new Error('User not found')
      const updated: PersistedUser = { ...existing, ...data }
      mockUsers.set(where.id, updated)
      return cloneSelectedUser(updated, select)
    }),
  },
}

const mockAuthService = {
  register: jest.fn(),
  login: jest.fn(),
  refresh: jest.fn(),
  logout: jest.fn(),
  issueStepUpChallenge: jest.fn(async () => ({ nonce: 'nonce', expiresAt: Date.now(), ttlSeconds: 300, challenge: 'webauthn-step-up' })),
  recordStepUpAssertion: jest.fn(async () => true),
  registerWebAuthnCredential: jest.fn(async () => ({})),
  validateStepUpSession: jest.fn(),
}

const mockRevokeSession = jest.fn()
const mockRevokeAllUserSessions = jest.fn()
const mockCreateAuditLog = jest.fn(async () => ({ id: 'audit-1' }))

jest.unstable_mockModule('../lib/prisma.js', () => ({ prisma: mockPrisma }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog: mockCreateAuditLog }))
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      userId: req.header('x-test-user-id') ?? 'admin-user-id',
      role: (req.header('x-test-role') as UserRole | null) ?? UserRole.ADMIN,
    } as any
    next()
  },
}))
jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))
jest.unstable_mockModule('../services/auth.service.js', () => ({ AuthService: mockAuthService }))
jest.unstable_mockModule('../services/session.js', () => ({
  revokeSession: mockRevokeSession,
  revokeAllUserSessions: mockRevokeAllUserSessions,
}))

const { authRouter } = await import('../routes/auth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

const ADMIN_ID = '99999999-9999-4999-9999-999999999999'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  mockUsers.clear()
  mockUsers.set(ADMIN_ID, {
    id: ADMIN_ID,
    email: 'admin@example.com',
    role: UserRole.ADMIN,
    status: 'ACTIVE',
    lastLoginAt: null,
  })
  mockUsers.set(TARGET_ID, {
    id: TARGET_ID,
    email: 'member@example.com',
    role: UserRole.USER,
    status: 'ACTIVE',
    lastLoginAt: null,
  })
  process.env.NODE_ENV = 'test'
})

describe('mock userId-only login boundary', () => {
  it('is disabled in production', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ userId: TARGET_ID })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('is rejected for malformed userId in non-production', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ userId: 'not-a-uuid' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('is allowed for a valid userId outside production', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ userId: TARGET_ID })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      user: { id: TARGET_ID, role: UserRole.USER },
      token: `mock-token-${TARGET_ID}`,
    })
  })
})

describe('POST /api/auth/login – real credential flow', () => {
  it('returns 401 when credentials are rejected server-side', async () => {
    jest.mocked(mockAuthService.login).mockRejectedValue(new Error('Invalid credentials'))
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'member@example.com', password: 'password123' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 400 for a malformed payload before reaching the service', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(mockAuthService.login).not.toHaveBeenCalled()
  })
})

describe('POST /api/auth/webauthn/assert boundary validation', () => {
  const validBody = {
    nonce: 'c0a6e0e8-4f5e-4a9c-9f4e-111111111111',
    credentialId: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_ab',
    publicKey: 'pqBWFZ9cm42yJYtI2+KRemoiXmpQHrpv4/Hg0E/DRvo',
  }

  it('rejects a non-UUID nonce', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/webauthn/assert')
      .set('x-test-user-id', ADMIN_ID)
      .send({ ...validBody, nonce: 'not-a-uuid' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(mockAuthService.recordStepUpAssertion).not.toHaveBeenCalled()
  })

  it('rejects credentialId shorter than the boundary', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/webauthn/assert')
      .set('x-test-user-id', ADMIN_ID)
      .send({ ...validBody, credentialId: 'tooshort' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects credentialId with invalid characters', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/webauthn/assert')
      .set('x-test-user-id', ADMIN_ID)
      .send({ ...validBody, credentialId: 'AAAAAAAAAAAAAAAAAAAA@@@@@@@@@@@@@@@' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a body whose JSON exceeds the AUTH_JSON_MAX_BYTES boundary', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/webauthn/assert')
      .set('x-test-user-id', ADMIN_ID)
      .send({ ...validBody, publicKey: 'A'.repeat(9000) })
    expect(res.status).toBe(413)
  })

  it('accepts a well-formed assertion and registers the credential', async () => {
    jest.mocked(mockAuthService.recordStepUpAssertion).mockResolvedValue(true)
    jest.mocked(mockAuthService.registerWebAuthnCredential).mockResolvedValue({} as any)
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/webauthn/assert')
      .set('x-test-user-id', ADMIN_ID)
      .send(validBody)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(mockAuthService.recordStepUpAssertion).toHaveBeenCalledWith(validBody.nonce, ADMIN_ID)
    expect(mockAuthService.registerWebAuthnCredential).toHaveBeenCalledWith(ADMIN_ID, validBody.credentialId, validBody.publicKey)
  })
})

describe('POST /api/auth/logout boundary validation', () => {
  it('rejects an oversized refreshToken in the body', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: 'A'.repeat(5000) })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(mockAuthService.logout).not.toHaveBeenCalled()
  })

  it('rejects a non-string refreshToken', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: { nested: true } })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('accepts logout without a refresh token when a session jti is present', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/logout')
      .set('x-test-user-id', ADMIN_ID)
      .send({})
    expect(res.status).toBe(200)
  })
})

describe('POST /api/auth/users/:id/role authorization boundary', () => {
  it('forbids non-admin role changes', async () => {
    const app = buildApp()
    const res = await request(app)
      .post(`/api/auth/users/${TARGET_ID}/role`)
      .set('x-test-role', UserRole.USER)
      .send({ role: UserRole.VERIFIER })
    expect(res.status).toBe(403)
  })

  it('rejects an invalid target id', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/auth/users/not-a-uuid/role')
      .set('x-test-role', UserRole.ADMIN)
      .send({ role: UserRole.VERIFIER })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects an admin attempting to change their own role', async () => {
    const app = buildApp()
    const res = await request(app)
      .post(`/api/auth/users/${ADMIN_ID}/role`)
      .set('x-test-user-id', ADMIN_ID)
      .set('x-test-role', UserRole.ADMIN)
      .send({ role: UserRole.USER })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('rejects invalid role payloads before mutating the persisted row', async () => {
    const app = buildApp()
    const res = await request(app)
      .post(`/api/auth/users/${TARGET_ID}/role`)
      .set('x-test-user-id', ADMIN_ID)
      .set('x-test-role', UserRole.ADMIN)
      .send({ role: 'SUPERUSER' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(mockUsers.get(TARGET_ID)?.role).toBe(UserRole.USER)
  })

  it('allows an admin to change another users role', async () => {
    const app = buildApp()
    const res = await request(app)
      .post(`/api/auth/users/${TARGET_ID}/role`)
      .set('x-test-user-id', ADMIN_ID)
      .set('x-test-role', UserRole.ADMIN)
      .send({ role: UserRole.VERIFIER })
    expect(res.status).toBe(200)
    expect(mockUsers.get(TARGET_ID)?.role).toBe(UserRole.VERIFIER)
  })
})
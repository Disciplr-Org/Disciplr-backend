import { jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { UserRole } from '../types/user.js'

type PersistedUser = {
  id: string
  email: string
  role: UserRole
  lastLoginAt: Date | null
}

const users = new Map<string, PersistedUser>()
const createAuditLog = jest.fn(async () => ({ id: 'audit-1' }))

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

const prisma = {
  user: {
    findUnique: jest.fn(async ({ where, select }: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) => {
      const user = where.id
        ? users.get(where.id)
        : Array.from(users.values()).find((entry) => entry.email === where.email)
      return cloneSelectedUser(user, select)
    }),
    update: jest.fn(async ({ where, data, select }: { where: { id: string }; data: Partial<PersistedUser>; select?: Record<string, boolean> }) => {
      const existing = users.get(where.id)
      if (!existing) {
        throw new Error('User not found')
      }

      const updated: PersistedUser = {
        ...existing,
        ...data,
      }
      users.set(where.id, updated)
      return cloneSelectedUser(updated, select)
    }),
  },
}

jest.unstable_mockModule('../lib/prisma.js', () => ({ prisma }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog }))
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      userId: req.header('x-test-user-id') ?? 'admin-user-id',
      role: (req.header('x-test-role') as UserRole | null) ?? UserRole.ADMIN,
    } as any
    next()
  },
}))
jest.unstable_mockModule('../services/auth.service.js', () => ({
  AuthService: {
    register: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
  },
}))
jest.unstable_mockModule('../services/session.js', () => ({
  revokeSession: jest.fn(),
  revokeAllUserSessions: jest.fn(),
}))

const { authRouter } = await import('./auth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

describe('auth router persisted user role paths', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    app.use(errorHandler)
    return app
  }

  beforeEach(() => {
    users.clear()
    users.set('11111111-1111-1111-1111-111111111111', {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'verifier@example.com',
      role: UserRole.VERIFIER,
      lastLoginAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    users.set('22222222-2222-2222-2222-222222222222', {
      id: '22222222-2222-2222-2222-222222222222',
      email: 'member@example.com',
      role: UserRole.USER,
      lastLoginAt: null,
    })
    createAuditLog.mockClear()
    prisma.user.findUnique.mockClear()
    prisma.user.update.mockClear()
  })

  it('reads the persisted role for userId-only login and updates lastLoginAt', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/api/auth/login')
      .send({ userId: '11111111-1111-1111-1111-111111111111' })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      user: {
        id: '11111111-1111-1111-1111-111111111111',
        role: UserRole.VERIFIER,
      },
      token: 'mock-token-11111111-1111-1111-1111-111111111111',
      auditLogId: 'audit-1',
    })

    expect(typeof response.body.user.lastLoginAt).toBe('string')
    expect(new Date(response.body.user.lastLoginAt).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00.000Z').getTime())
    expect(users.get('11111111-1111-1111-1111-111111111111')?.role).toBe(UserRole.VERIFIER)
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actor_user_id: '11111111-1111-1111-1111-111111111111',
      action: 'auth.login',
      metadata: expect.objectContaining({
        userAgent: 'unknown',
      }),
    }))
    expect(createAuditLog.mock.calls[0]?.[0]?.metadata).not.toHaveProperty('email')
  })

  it('updates persisted roles via prisma instead of process memory', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/api/auth/users/22222222-2222-2222-2222-222222222222/role')
      .set('x-test-user-id', '99999999-9999-9999-9999-999999999999')
      .set('x-test-role', UserRole.ADMIN)
      .send({ role: UserRole.ADMIN })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      user: {
        id: '22222222-2222-2222-2222-222222222222',
        role: UserRole.ADMIN,
        lastLoginAt: null,
      },
      auditLogId: 'audit-1',
    })
    expect(users.get('22222222-2222-2222-2222-222222222222')?.role).toBe(UserRole.ADMIN)
    expect(createAuditLog).toHaveBeenCalledWith({
      actor_user_id: '99999999-9999-9999-9999-999999999999',
      action: 'auth.role_changed',
      target_type: 'user',
      target_id: '22222222-2222-2222-2222-222222222222',
      metadata: {
        previousRole: UserRole.USER,
        newRole: UserRole.ADMIN,
      },
    })
  })

  it('rejects invalid role payloads before mutating the persisted user row', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/api/auth/users/22222222-2222-2222-2222-222222222222/role')
      .set('x-test-role', UserRole.ADMIN)
      .send({ role: 'SUPERUSER' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(users.get('22222222-2222-2222-2222-222222222222')?.role).toBe(UserRole.USER)
    expect(createAuditLog).not.toHaveBeenCalled()
  })
})

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
const createAuditLog = jest.fn(async () => ({ id: 'audit-persist' }))

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

const installMocks = () => {
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
}

const loadApp = async () => {
  jest.resetModules()
  installMocks()

  const { authRouter } = await import('../routes/auth.js')
  const { errorHandler } = await import('../middleware/errorHandler.js')

  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

describe('auth role persistence across router reloads', () => {
  beforeEach(() => {
    users.clear()
    users.set('33333333-3333-3333-3333-333333333333', {
      id: '33333333-3333-3333-3333-333333333333',
      email: 'restart@example.com',
      role: UserRole.USER,
      lastLoginAt: null,
    })
    createAuditLog.mockClear()
    prisma.user.findUnique.mockClear()
    prisma.user.update.mockClear()
  })

  it('persists a role change across simulated process restarts', async () => {
    const appBeforeRestart = await loadApp()

    const roleUpdate = await request(appBeforeRestart)
      .post('/api/auth/users/33333333-3333-3333-3333-333333333333/role')
      .set('x-test-user-id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
      .set('x-test-role', UserRole.ADMIN)
      .send({ role: UserRole.ADMIN })

    expect(roleUpdate.status).toBe(200)
    expect(users.get('33333333-3333-3333-3333-333333333333')?.role).toBe(UserRole.ADMIN)

    const appAfterRestart = await loadApp()
    const loginAfterRestart = await request(appAfterRestart)
      .post('/api/auth/login')
      .send({ userId: '33333333-3333-3333-3333-333333333333' })

    expect(loginAfterRestart.status).toBe(200)
    expect(loginAfterRestart.body.user).toMatchObject({
      id: '33333333-3333-3333-3333-333333333333',
      role: UserRole.ADMIN,
    })
  })
})

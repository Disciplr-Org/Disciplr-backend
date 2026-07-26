/**
 * Regression test: AuthService.login / AuthService.refresh must not throw
 * TS2304 (Cannot find name 'getEnv') at runtime.
 *
 * Unlike auth.breachReuse.test.ts and auth.persistence.test.ts, this suite
 * does NOT mock ../lib/auth-utils.js — exercising the *real* generateAccessToken,
 * generateRefreshToken, verifyRefreshToken and comparePassword functions, all of
 * which flow through AuthService's calls to getEnv().
 *
 * If someone removes the `import { getEnv } from '../config/env.js'` line from
 * auth.service.ts again, this test will fail with a ReferenceError at the very
 * first getEnv() call inside AuthService.login.
 */

import { jest } from '@jest/globals'

// ── Set up env BEFORE any auth-service code is imported ──────────────
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/testdb'
process.env.JWT_SECRET = 'test-secret-that-is-at-least-16-char'
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough'
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough'

// Init env so getEnv() doesn't throw "Env not initialized"
const { initEnv } = await import('../config/env.js')
initEnv()

// ── Mocks ────────────────────────────────────────────────────────────
const createAuditLog = jest.fn(async () => ({ id: 'audit-1' }))
const recordSession = jest.fn(async () => undefined)
const revokeAllUserSessions = jest.fn(async () => undefined)

const users = new Map<string, any>()
const refreshTokens = new Map<string, any>()

const mockPrisma = {
  user: {
    create: jest.fn(async ({ data }: { data: any }) => {
      const user = {
        id: `user-${users.size + 1}`,
        email: data.email,
        role: data.role,
        passwordHash: data.passwordHash,
        lastLoginAt: null,
      }
      users.set(user.id, user)
      return user
    }),
    findUnique: jest.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
      if (where.email) {
        return Array.from(users.values()).find((u) => u.email === where.email) ?? null
      }
      if (where.id) {
        return users.get(where.id) ?? null
      }
      return null
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
      const current = users.get(where.id)
      if (!current) {
        throw new Error('User not found')
      }
      const updated = { ...current, ...data }
      users.set(where.id, updated)
      return updated
    }),
  },
  refreshToken: {
    findUnique: jest.fn(async ({ where }: { where: { token?: string } }) => {
      return refreshTokens.get(where.token) ?? null
    }),
    create: jest.fn(async ({ data }: { data: any }) => {
      const entry = { id: `refresh-${refreshTokens.size + 1}`, ...data, user: null }
      refreshTokens.set(data.token, entry)
      return entry
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
      // find by iterating
      let target: any = null
      for (const [, v] of refreshTokens) {
        if (v.id === where.id) {
          target = v
          break
        }
      }
      if (!target) throw new Error('Refresh token not found')
      Object.assign(target, data)
      return target
    }),
    updateMany: jest.fn(async ({ where, data }: { where: { userId?: string; revokedAt?: null }; data: any }) => {
      let count = 0
      for (const [, v] of refreshTokens) {
        if (where.userId && v.userId !== where.userId) continue
        if (where.revokedAt === null && v.revokedAt !== null) continue
        v.revokedAt = data.revokedAt
        count++
      }
      return { count }
    }),
  },
  $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
  $executeRaw: jest.fn(async () => {}),
}

const getPrisma = jest.fn(() => mockPrisma)
const hashToken = (token: string) => `hash-${token}`

jest.unstable_mockModule('../lib/prismaScope.js', () => ({ getPrisma }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog }))
jest.unstable_mockModule('../services/session.js', () => ({ recordSession, revokeAllUserSessions }))

// NOTE: We do NOT mock ../lib/auth-utils.js so the real getEnv() calls
// inside auth.service.ts are exercised.

describe('AuthService login + refresh — regression (getEnv import)', () => {
  beforeEach(() => {
    users.clear()
    refreshTokens.clear()
    jest.clearAllMocks()
  })

  it('AuthService.login succeeds end-to-end (real getEnv, real auth-utils)', async () => {
    const { AuthService } = await import('../services/auth.service.js')

    // Register a user first
    const registered = await AuthService.register({
      email: 'test@example.com',
      password: 'SecurePassword123!',
    } as any)

    expect(registered.email).toBe('test@example.com')
    expect(registered.id).toBeTruthy()

    // Now login — this calls getEnv() inside the login method
    const loginResult = await AuthService.login({
      email: 'test@example.com',
      password: 'SecurePassword123!',
    } as any)

    expect(loginResult).toHaveProperty('accessToken')
    expect(loginResult).toHaveProperty('refreshToken')
    expect(loginResult.user).toMatchObject({
      id: registered.id,
      email: 'test@example.com',
    })
    // Verify the access token is a real JWT string (3 dot-separated segments)
    expect(loginResult.accessToken.split('.')).toHaveLength(3)
  })

  it('AuthService.refresh succeeds end-to-end (real getEnv, real auth-utils)', async () => {
    const { AuthService } = await import('../services/auth.service.js')

    // Register and login to get a refresh token
    await AuthService.register({
      email: 'refresh-test@example.com',
      password: 'AnotherSecurePwd1!',
    } as any)

    const loginResult = await AuthService.login({
      email: 'refresh-test@example.com',
      password: 'AnotherSecurePwd1!',
    } as any)

    const refreshTokenValue = loginResult.refreshToken

    // AuthService.refresh calls verifyRefreshToken(token, getEnv())
    // and then later generateAccessToken(..., getEnv()) / generateRefreshToken(..., getEnv())
    const refreshResult = await AuthService.refresh(refreshTokenValue)

    expect(refreshResult).toHaveProperty('accessToken')
    expect(refreshResult).toHaveProperty('refreshToken')
    expect(refreshResult.accessToken.split('.')).toHaveLength(3)
    expect(refreshResult.refreshToken).not.toBe(refreshTokenValue) // rotated
  })
})
</absolute_path>
</create_file>

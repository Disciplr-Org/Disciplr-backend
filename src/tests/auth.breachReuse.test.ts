import { jest } from '@jest/globals'

const createAuditLog = jest.fn(async () => ({ id: 'audit-1' }))
const recordSession = jest.fn(async () => undefined)
const revokeAllUserSessions = jest.fn(async () => undefined)

const users = new Map<string, any>()
const refreshTokens = new Map<string, any>()

const prisma = {
  user: {
    create: jest.fn(async ({ data }: { data: any }) => {
      const user = { id: `user-${users.size + 1}`, email: data.email, role: data.role, passwordHash: data.passwordHash }
      users.set(user.id, user)
      return user
    }),
    findUnique: jest.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
      if (where.email) {
        return Array.from(users.values()).find((user) => user.email === where.email) ?? null
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
      if (where.token) {
        return refreshTokens.get(where.token) ?? null
      }
      return null
    }),
    create: jest.fn(async ({ data }: { data: any }) => {
      refreshTokens.set(data.token, { id: `refresh-${refreshTokens.size + 1}`, ...data })
      return null
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
      const token = refreshTokens.get(where.id)
      if (!token) {
        throw new Error('Refresh token not found')
      }
      const updated = { ...token, ...data }
      refreshTokens.set(where.id, updated)
      return updated
    }),
    updateMany: jest.fn(async ({ where, data }: { where: any; data: any }) => {
      const matches = Array.from(refreshTokens.values()).filter((entry) => {
        if (where.userId && entry.userId !== where.userId) return false
        if (where.revokedAt === null && entry.revokedAt !== null) return false
        return true
      })
      matches.forEach((entry) => {
        entry.revokedAt = data.revokedAt
      })
      return { count: matches.length }
    }),
  },
  $transaction: jest.fn(async (callback: any) => callback(prisma)),
}

const getPrisma = jest.fn(() => prisma)

jest.unstable_mockModule('../lib/prismaScope.js', () => ({ getPrisma }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog }))
jest.unstable_mockModule('../services/session.js', () => ({ recordSession, revokeAllUserSessions }))
jest.unstable_mockModule('../lib/auth-utils.js', () => ({
  verifyRefreshToken: (token: string) => ({ token }),
  hashToken: (token: string) => {
    if (token === 'replay-token-123') return 'token-hash-replay'
    return `hash-${token}`
  },
  generateAccessToken: () => 'access-token-mock',
  generateRefreshToken: () => 'refresh-token-mock',
  hashPassword: async (p: string) => `hashed-${p}`,
  comparePassword: async (p: string, h: string) => h === `hashed-${p}`,
}))

describe('AuthService breach and refresh reuse protections', () => {
  beforeEach(() => {
    users.clear()
    refreshTokens.clear()
    createAuditLog.mockClear()
    recordSession.mockClear()
    revokeAllUserSessions.mockClear()
    prisma.user.create.mockClear()
    prisma.user.findUnique.mockClear()
    prisma.user.update.mockClear()
    prisma.refreshToken.findUnique.mockClear()
    prisma.refreshToken.create.mockClear()
    prisma.refreshToken.update.mockClear()
    prisma.refreshToken.updateMany.mockClear()
    prisma.$transaction.mockClear()
    process.env.AUTH_BREACHED_PASSWORDS_ENABLED = 'true'
    process.env.AUTH_BREACHED_PASSWORDS = 'Password123!'
    // Provide minimal env for config validation during tests
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/testdb'
  })

  afterEach(() => {
    delete process.env.AUTH_BREACHED_PASSWORDS_ENABLED
    delete process.env.AUTH_BREACHED_PASSWORDS
  })

  it('rejects breached passwords during registration and does not log the password', async () => {
    const { AuthService } = await import('../services/auth.service.js')

    await expect(AuthService.register({ email: 'user@example.com', password: 'Password123!' } as any)).rejects.toThrow('Password rejected')

    expect(prisma.user.create).not.toHaveBeenCalled()
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.password_rejected',
      metadata: expect.objectContaining({ reason: 'breached_password' }),
    }))

    const auditMetadata = createAuditLog.mock.calls[0][0].metadata
    expect(auditMetadata.password).toBeUndefined()
    expect(JSON.stringify(auditMetadata)).not.toContain('Password123!')
  })

  it('accepts a clean password and hashes it for registration', async () => {
    const { AuthService } = await import('../services/auth.service.js')

    const result = await AuthService.register({ email: 'clean@example.com', password: 'AveryCleanPassword!2' } as any)

    expect(result.email).toBe('clean@example.com')
    expect(prisma.user.create).toHaveBeenCalledTimes(1)
    expect(prisma.user.create.mock.calls[0][0].data.passwordHash).not.toEqual('AveryCleanPassword!2')
  })

  it('rejects breached passwords during password changes', async () => {
    const { AuthService } = await import('../services/auth.service.js')

    const user = await prisma.user.create({ data: { email: 'change@example.com', passwordHash: 'hash', role: 'USER' } })

    await expect(AuthService.changePassword(user.id, 'Password123!')).rejects.toThrow('Password rejected')
    expect(prisma.user.update).not.toHaveBeenCalled()
  })

  it('revokes the refresh-token family and emits an audit event when a rotated token is replayed', async () => {
    const { AuthService } = await import('../services/auth.service.js')

    const incomingToken = 'replay-token-123'
    const tokenHash = 'token-hash-replay'
    const user = { id: 'user-replay', role: 'USER' }

    refreshTokens.set(tokenHash, {
      id: 'refresh-1',
      token: tokenHash,
      userId: user.id,
      user,
      expiresAt: new Date('2099-01-01'),
      revokedAt: new Date('2026-01-01'),
    })

    await expect(AuthService.refresh(incomingToken)).rejects.toThrow('Invalid refresh token')

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: user.id }),
    }))
    expect(revokeAllUserSessions).toHaveBeenCalledWith(user.id)
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.refresh_token_reuse_detected',
      metadata: expect.objectContaining({ reason: 'refresh_token_reuse' }),
    }))
    const auditMetadata = createAuditLog.mock.calls[0][0].metadata
    expect(JSON.stringify(auditMetadata)).not.toContain(incomingToken)
  })
})

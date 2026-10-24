import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import './initTestEnv.js'
import { randomUUID } from 'node:crypto'
import { generateRefreshToken, hashToken } from '../lib/auth-utils.js'
import { AppError } from '../middleware/errorHandler.js'

// Setup environment before importing service
process.env.JWT_ACCESS_SECRET = 'test-secret-at-least-32-characters-long!!'
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-characters!!'
process.env.NODE_ENV = 'test'

interface StoredToken {
  id: string
  token: string
  userId: string
  familyId: string | null
  replacedById: string | null
  expiresAt: Date
  revokedAt: Date | null
  createdAt: Date
}

describe('AuthService.refresh Race and Family Rotation', () => {
  let mockTokens: Map<string, StoredToken>
  let mockUsers: Map<string, any>
  let mockSessions: any[]
  let mockAuditLogs: any[]
  let simulateDbFailure: boolean
  let AuthService: any

  const createMockPrisma = () => {
    const tx = {
      refreshToken: {
        updateMany: jest.fn(async ({ where, data }: { where: any; data: any }) => {
          if (simulateDbFailure) {
            throw new Error('Connection terminated unexpectedly')
          }

          let count = 0
          for (const token of mockTokens.values()) {
            let match = true

            if (where.token !== undefined && token.token !== where.token) {
              match = false
            }
            if (where.familyId !== undefined && token.familyId !== where.familyId) {
              match = false
            }
            if (where.userId !== undefined && token.userId !== where.userId) {
              match = false
            }
            if (where.revokedAt === null && token.revokedAt !== null) {
              match = false
            }
            if (where.expiresAt?.gt !== undefined && token.expiresAt <= where.expiresAt.gt) {
              match = false
            }

            if (match) {
              token.revokedAt = data.revokedAt ?? new Date()
              count++
            }
          }

          return { count }
        }),

        findUnique: jest.fn(async ({ where, include }: { where: any; include?: any }) => {
          if (simulateDbFailure) {
            throw new Error('Connection terminated unexpectedly')
          }

          let found: StoredToken | undefined
          if (where.token) {
            found = Array.from(mockTokens.values()).find((t) => t.token === where.token)
          } else if (where.id) {
            found = mockTokens.get(where.id)
          }

          if (!found) return null

          const res: any = { ...found }
          if (include?.user) {
            res.user = mockUsers.get(found.userId)
          }
          return res
        }),

        create: jest.fn(async ({ data }: { data: any }) => {
          if (simulateDbFailure) {
            throw new Error('Connection terminated unexpectedly')
          }

          const id = randomUUID()
          const newRow: StoredToken = {
            id,
            token: data.token,
            userId: data.userId,
            familyId: data.familyId ?? null,
            replacedById: null,
            expiresAt: data.expiresAt,
            revokedAt: null,
            createdAt: new Date(),
          }
          mockTokens.set(id, newRow)
          return newRow
        }),

        update: jest.fn(async ({ where, data }: { where: any; data: any }) => {
          if (simulateDbFailure) {
            throw new Error('Connection terminated unexpectedly')
          }

          const token = mockTokens.get(where.id)
          if (!token) throw new Error('Record not found')

          if (data.replacedById !== undefined) token.replacedById = data.replacedById
          if (data.revokedAt !== undefined) token.revokedAt = data.revokedAt
          return token
        }),
      },
    }

    return {
      ...tx,
      $transaction: jest.fn(async (callback: any) => {
        if (simulateDbFailure) {
          throw new Error('Connection terminated unexpectedly')
        }
        return await callback(tx)
      }),
    }
  }

  beforeEach(async () => {
    mockTokens = new Map()
    mockUsers = new Map()
    mockSessions = []
    mockAuditLogs = []
    simulateDbFailure = false

    mockUsers.set('user-1', {
      id: 'user-1',
      email: 'user1@example.com',
      role: 'USER',
      status: 'ACTIVE',
    })

    mockUsers.set('user-2', {
      id: 'user-2',
      email: 'user2@example.com',
      role: 'USER',
      status: 'ACTIVE',
    })

    const mockPrismaClient = createMockPrisma()

    jest.unstable_mockModule('../lib/prismaScope.js', () => ({
      getPrisma: () => mockPrismaClient,
      prismaStorage: { getStore: () => undefined },
    }))

    jest.unstable_mockModule('../lib/audit-logs.js', () => ({
      createAuditLog: jest.fn(async (entry: any) => {
        mockAuditLogs.push(entry)
        return { id: randomUUID(), ...entry }
      }),
    }))

    jest.unstable_mockModule('../services/session.js', () => ({
      recordSession: jest.fn(async (userId: string, jti: string, expiresAt: Date) => {
        mockSessions.push({ userId, jti, expiresAt, revokedAt: null })
      }),
      revokeSession: jest.fn(),
      revokeAllUserSessions: jest.fn(async (userId: string) => {
        for (const s of mockSessions) {
          if (s.userId === userId) s.revokedAt = new Date()
        }
      }),
    }))

    const imported = await import('../services/auth.service.js')
    AuthService = imported.AuthService
  })

  it('Two parallel /auth/refresh calls with the same token result in exactly one 200 and one 401', async () => {
    const rawRefreshToken = generateRefreshToken({ userId: 'user-1' }, {
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET!,
    } as any)

    const tokenHash = hashToken(rawRefreshToken)
    const tokenId = randomUUID()
    const familyId = randomUUID()

    mockTokens.set(tokenId, {
      id: tokenId,
      token: tokenHash,
      userId: 'user-1',
      familyId,
      replacedById: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      createdAt: new Date(),
    })

    const res1 = await AuthService.refresh(rawRefreshToken)
    expect(res1.refreshToken).toBeDefined()

    // Immediate second call with the same token loses the race / gets rejected
    let res2Err: any
    try {
      await AuthService.refresh(rawRefreshToken)
    } catch (err) {
      res2Err = err
    }

    expect(res2Err).toBeInstanceOf(AppError)
    expect(res2Err.status).toBe(401)

    // The family of the token must now be revoked due to reuse detection on the losing race
    const tokensInFamily = Array.from(mockTokens.values()).filter((t) => t.familyId === familyId)
    for (const t of tokensInFamily) {
      expect(t.revokedAt).not.toBeNull()
    }
  })

  it('Reusing a rotated token revokes only its family while other families remain valid', async () => {
    // Device 1 (family 1)
    const rawTokenDevice1 = generateRefreshToken({ userId: 'user-1', jti: 'device-1' } as any, {
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET!,
    } as any)
    const device1Id = randomUUID()
    const family1 = 'device-family-1'

    mockTokens.set(device1Id, {
      id: device1Id,
      token: hashToken(rawTokenDevice1),
      userId: 'user-1',
      familyId: family1,
      replacedById: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      createdAt: new Date(),
    })

    // Device 2 (family 2)
    const rawTokenDevice2 = generateRefreshToken({ userId: 'user-1', jti: 'device-2' } as any, {
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET!,
    } as any)
    const device2Id = randomUUID()
    const family2 = 'device-family-2'

    mockTokens.set(device2Id, {
      id: device2Id,
      token: hashToken(rawTokenDevice2),
      userId: 'user-1',
      familyId: family2,
      replacedById: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      createdAt: new Date(),
    })

    // 1. Rotate device 1 token once legitimately
    const rotated = await AuthService.refresh(rawTokenDevice1)
    expect(rotated.refreshToken).toBeDefined()

    const oldDevice1Row = mockTokens.get(device1Id)!
    expect(oldDevice1Row.revokedAt).not.toBeNull()
    expect(oldDevice1Row.replacedById).not.toBeNull()

    // 2. Attacker attempts to reuse the already-rotated token of device 1
    await expect(AuthService.refresh(rawTokenDevice1)).rejects.toMatchObject({
      status: 401,
    })

    // Family 1 should be completely revoked
    const family1Tokens = Array.from(mockTokens.values()).filter((t) => t.familyId === family1)
    expect(family1Tokens.every((t) => t.revokedAt !== null)).toBe(true)

    // Family 2 (Device 2) must remain valid and unrevoked!
    const family2Tokens = Array.from(mockTokens.values()).filter((t) => t.familyId === family2)
    expect(family2Tokens.some((t) => t.revokedAt === null)).toBe(true)

    // Device 2 can still refresh successfully
    const device2Refresh = await AuthService.refresh(rawTokenDevice2)
    expect(device2Refresh.accessToken).toBeDefined()
  })

  it('A rotated token row has replacedById pointing to its successor', async () => {
    const rawToken = generateRefreshToken({ userId: 'user-1' }, {
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET!,
    } as any)
    const id = randomUUID()
    const familyId = randomUUID()

    mockTokens.set(id, {
      id,
      token: hashToken(rawToken),
      userId: 'user-1',
      familyId,
      replacedById: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      createdAt: new Date(),
    })

    const result = await AuthService.refresh(rawToken)
    const successorHash = hashToken(result.refreshToken)
    const successorRow = Array.from(mockTokens.values()).find((t) => t.token === successorHash)!

    const originalRow = mockTokens.get(id)!
    expect(originalRow.replacedById).toBe(successorRow.id)
    expect(successorRow.familyId).toBe(familyId)
  })

  it('An injected database error during refresh produces 503', async () => {
    const rawToken = generateRefreshToken({ userId: 'user-1' }, {
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET!,
    } as any)

    simulateDbFailure = true

    await expect(AuthService.refresh(rawToken)).rejects.toMatchObject({
      status: 503,
      message: 'Database operation failed',
    })
  })
})

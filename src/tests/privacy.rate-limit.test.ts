import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAuthenticate = jest.fn<any>()
const mockUtcNow = jest.fn<any>().mockReturnValue('2025-01-01T00:00:00Z')
const mockCreateAuditLog = jest.fn<any>()
const mockVaultFindMany = jest.fn<any>()
const mockVaultDeleteMany = jest.fn<any>()

// Mock rate limiter to a no-op so route tests aren't throttled by the singleton
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  strictRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: mockAuthenticate,
}))

jest.unstable_mockModule('../utils/timestamps.js', () => ({
  utcNow: mockUtcNow,
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    vault: {
      findMany: mockVaultFindMany,
      deleteMany: mockVaultDeleteMany,
    },
  },
}))

const { privacyRouter, privacyAbuseMonitor } = await import('../routes/privacy.js')

import request from 'supertest'
import express from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { notFound } from '../middleware/notFound.js'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/privacy', privacyRouter)
  app.use(notFound)
  app.use(errorHandler)
  return app
}

function setAuthUser(userId: string, role = 'USER') {
  mockAuthenticate.mockImplementation((req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId, role } as any
    next()
  })
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Privacy GET /export – ownership & enumeration resistance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    privacyAbuseMonitor.reset()
    setAuthUser('my-creator')
  })

  it('returns 400 when creator parameter is missing', async () => {
    const app = buildApp()
    const res = await request(app).get('/api/privacy/export').expect(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('returns 400 for empty creator parameter', async () => {
    const app = buildApp()
    const res = await request(app).get('/api/privacy/export?creator=').expect(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('returns 404 with generic message for non-owned creator (no enumeration)', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/api/privacy/export?creator=not-my-creator')
      .expect(404)

    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Creator not found' },
    })
  })

  it('returns 200 for owned creator with data', async () => {
    mockVaultFindMany.mockResolvedValue([
      { id: 'vault-1', creatorId: 'my-creator' },
    ])

    const app = buildApp()
    const res = await request(app)
      .get('/api/privacy/export?creator=my-creator')
      .expect(200)

    expect(res.body).toMatchObject({
      creator: 'my-creator',
      data: { vaults: expect.any(Array) },
    })
    expect(res.body.data.vaults).toHaveLength(1)
  })

  it('returns 200 with empty array for owned creator with no data', async () => {
    mockVaultFindMany.mockResolvedValue([])

    const app = buildApp()
    const res = await request(app)
      .get('/api/privacy/export?creator=my-creator')
      .expect(200)

    expect(res.body.data.vaults).toEqual([])
  })
})

describe('Privacy DELETE /account – erasure & audit logging', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    privacyAbuseMonitor.reset()
    setAuthUser('my-creator')
  })

  it('returns 400 when creator parameter is missing', async () => {
    const app = buildApp()
    const res = await request(app).delete('/api/privacy/account').expect(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('returns 400 for empty creator parameter', async () => {
    const app = buildApp()
    const res = await request(app).delete('/api/privacy/account?creator=').expect(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('returns 404 with generic message for non-owned creator (no enumeration)', async () => {
    const app = buildApp()
    const res = await request(app)
      .delete('/api/privacy/account?creator=stranger')
      .expect(404)

    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Creator not found' },
    })
  })

  it('returns 200, deletes, and writes audit log for owned creator', async () => {
    mockVaultDeleteMany.mockResolvedValue({ count: 3 })
    mockCreateAuditLog.mockResolvedValue({ id: 'audit-1' })

    const app = buildApp()
    const res = await request(app)
      .delete('/api/privacy/account?creator=my-creator')
      .expect(200)

    expect(res.body).toMatchObject({
      message: 'Account data has been deleted.',
      deletedCount: 3,
      status: 'success',
    })
    expect(mockCreateAuditLog).toHaveBeenCalledWith({
      actor_user_id: 'my-creator',
      action: 'privacy.account_erasure',
      target_type: 'creator',
      target_id: 'my-creator',
      metadata: { admin: false },
    })
  })

  it('returns 404 for owned creator with no records and does NOT write audit log', async () => {
    mockVaultDeleteMany.mockResolvedValue({ count: 0 })

    const app = buildApp()
    const res = await request(app)
      .delete('/api/privacy/account?creator=my-creator')
      .expect(404)

    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Creator not found' },
    })
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })

  it('same generic 404 response for non-owned creator as for non-existent creator', async () => {
    mockVaultDeleteMany.mockResolvedValue({ count: 0 })
    const app = buildApp()

    const ownedNonexistent = await request(app)
      .delete('/api/privacy/account?creator=my-creator')
      .expect(404)

    const unauthorized = await request(app)
      .delete('/api/privacy/account?creator=stranger')
      .expect(404)

    expect(ownedNonexistent.body).toEqual(unauthorized.body)
  })
})

describe('Privacy endpoints – admin override', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    privacyAbuseMonitor.reset()
  })

  it('admin can export any creator data', async () => {
    setAuthUser('admin-user', 'ADMIN')
    mockVaultFindMany.mockResolvedValue([{ id: 'vault-99', creatorId: 'any-creator' }])

    const app = buildApp()
    const res = await request(app)
      .get('/api/privacy/export?creator=any-creator')
      .expect(200)

    expect(res.body.data.vaults).toHaveLength(1)
  })

  it('admin can delete any creator data and audit log marks admin flag', async () => {
    setAuthUser('admin-user', 'ADMIN')
    mockVaultDeleteMany.mockResolvedValue({ count: 5 })
    mockCreateAuditLog.mockResolvedValue({ id: 'audit-1' })

    const app = buildApp()
    const res = await request(app)
      .delete('/api/privacy/account?creator=any-creator')
      .expect(200)

    expect(res.body.deletedCount).toBe(5)
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'admin-user',
        metadata: { admin: true },
      }),
    )
  })

  it('admin export on non-existent creator returns empty data', async () => {
    setAuthUser('admin-user', 'ADMIN')
    mockVaultFindMany.mockResolvedValue([])

    const app = buildApp()
    const res = await request(app)
      .get('/api/privacy/export?creator=nobody')
      .expect(200)

    expect(res.body.data.vaults).toEqual([])
  })
})

describe('Privacy endpoints – abuse monitoring', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    privacyAbuseMonitor.reset()
  })

  it('calls abuseMonitor.record for non-owned GET export requests', async () => {
    const recordSpy = jest.spyOn(privacyAbuseMonitor, 'record')
    setAuthUser('legit-user', 'USER')
    const app = buildApp()

    await request(app).get('/api/privacy/export?creator=target-a').expect(404)

    expect(recordSpy).toHaveBeenCalledTimes(1)
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'request',
        category: expect.objectContaining({ type: 'enumeration' }),
      }),
    )
    recordSpy.mockRestore()
  })

  it('calls abuseMonitor.record for non-owned DELETE account requests', async () => {
    const recordSpy = jest.spyOn(privacyAbuseMonitor, 'record')
    setAuthUser('legit-user', 'USER')
    const app = buildApp()

    await request(app).delete('/api/privacy/account?creator=victim-1').expect(404)

    expect(recordSpy).toHaveBeenCalledTimes(1)
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'request',
        weight: 10,
        category: expect.objectContaining({ type: 'enumeration' }),
      }),
    )
    recordSpy.mockRestore()
  })

  it('does NOT call abuseMonitor.record for owned-creator requests', async () => {
    const recordSpy = jest.spyOn(privacyAbuseMonitor, 'record')
    setAuthUser('owner-user', 'USER')
    mockVaultFindMany.mockResolvedValue([])
    mockVaultDeleteMany.mockResolvedValue({ count: 0 })

    const app = buildApp()
    await request(app).get('/api/privacy/export?creator=owner-user').expect(200)
    await request(app).delete('/api/privacy/account?creator=owner-user').expect(404)

    expect(recordSpy).not.toHaveBeenCalled()
    recordSpy.mockRestore()
  })

  it('does NOT call abuseMonitor.record for admin requests', async () => {
    const recordSpy = jest.spyOn(privacyAbuseMonitor, 'record')
    setAuthUser('admin-user', 'ADMIN')
    mockVaultFindMany.mockResolvedValue([])
    mockVaultDeleteMany.mockResolvedValue({ count: 0 })

    const app = buildApp()
    await request(app).get('/api/privacy/export?creator=anyone').expect(200)
    await request(app).delete('/api/privacy/account?creator=anyone').expect(404)

    expect(recordSpy).not.toHaveBeenCalled()
    recordSpy.mockRestore()
  })
})

describe('Privacy endpoints – authentication', () => {
  beforeEach(() => {
    privacyAbuseMonitor.reset()
  })

  it('returns 401 when not authenticated (GET)', async () => {
    mockAuthenticate.mockImplementation((_req: Request, res: Response, _next: NextFunction) => {
      res.status(401).json({ error: 'Unauthorized' })
    })

    const app = buildApp()
    const res = await request(app)
      .get('/api/privacy/export?creator=any')
      .expect(401)

    expect(res.body.error).toBe('Unauthorized')
  })

  it('returns 401 when not authenticated (DELETE)', async () => {
    mockAuthenticate.mockImplementation((_req: Request, res: Response, _next: NextFunction) => {
      res.status(401).json({ error: 'Unauthorized' })
    })

    const app = buildApp()
    const res = await request(app)
      .delete('/api/privacy/account?creator=any')
      .expect(401)

    expect(res.body.error).toBe('Unauthorized')
  })
})

describe('Privacy endpoints – repeated erasure (idempotency)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    privacyAbuseMonitor.reset()
    setAuthUser('my-creator')
  })

  it('subsequent DELETE returns 404 when data already deleted', async () => {
    mockVaultDeleteMany
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValue({ count: 0 })
    mockCreateAuditLog.mockResolvedValue({ id: 'audit-1' })

    const app = buildApp()

    const first = await request(app)
      .delete('/api/privacy/account?creator=my-creator')
      .expect(200)
    expect(first.body.status).toBe('success')

    const second = await request(app)
      .delete('/api/privacy/account?creator=my-creator')
      .expect(404)
    expect(second.body.error).toEqual({
      code: 'NOT_FOUND',
      message: 'Creator not found',
    })
  })
})

describe('Rate limiter – throttling behavior per endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    privacyAbuseMonitor.reset()
  })

  it('strictRateLimiter rejects requests above limit', async () => {
    // Use a fresh express-rate-limit instance (bypasses jest mock cache)
    const { default: rateLimit } = await import('express-rate-limit')

    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 3,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } },
    })

    const app = express()
    app.use(limiter)
    app.get('/test', (_req: Request, res: Response) => res.json({ ok: true }))

    for (let i = 0; i < 3; i++) {
      await request(app).get('/test').expect(200)
    }

    const res = await request(app).get('/test').expect(429)
    expect(res.body.error.code).toBe('RATE_LIMITED')
  })
})

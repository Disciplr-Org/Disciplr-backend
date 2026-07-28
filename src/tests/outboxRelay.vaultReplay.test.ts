import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'

// ── Declare mocks BEFORE any imports ──────────────────────────────────────────
const createAuditLog = jest.fn()
jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog,
  getAuditLogById: jest.fn(),
  listAuditLogs: jest.fn(),
}))

const mockDbQuery = {
  whereRaw: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockImplementation(async () => []),
}

const mockDb = jest.fn((tableName: string) => {
  if (tableName === 'vault_outbox') {
    return mockDbQuery
  }
  return mockDbQuery
})

jest.unstable_mockModule('../db/index.js', () => ({
  db: mockDb,
}))

jest.unstable_mockModule('../db/knex.js', () => ({
  db: mockDb,
}))

const dispatchWebhookEvent = jest.fn(async () => [])
jest.unstable_mockModule('../services/webhooks.js', () => ({
  dispatchWebhookEvent,
  replayDeadLetter: jest.fn(),
  upsertSubscriber: jest.fn(),
  rotateSubscriberSecret: jest.fn(),
  listSubscribers: jest.fn(async () => []),
  addEgressAllowlistEntry: jest.fn(),
  removeEgressAllowlistEntry: jest.fn(),
  listEgressAllowlist: jest.fn(),
  updateSubscriberFieldPolicy: jest.fn(),
}))

// Mock the rate limiter to not block tests, but we can verify it is configured
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  strictRateLimiter: (req: any, res: any, next: any) => next(),
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: jest.fn<any>((req: any, res: any, next: any) => {
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const token = auth.slice(7)
    if (token === 'admin') {
      req.user = { userId: 'admin-1', role: 'ADMIN' }
      return next()
    }
    if (token === 'user') {
      req.user = { userId: 'user-1', role: 'USER' }
      return next()
    }
    return res.status(401).json({ error: 'Unauthorized' })
  }),
}))

// ── Import modules after mocks apply ──────────────────────────────────────────
const { replayForVault } = await import('../services/outboxRelay.js')
const { adminVaultReplayRouter } = await import('../routes/adminWebhooks.js')

const app = express()
app.use(express.json())
app.use('/api/admin/vaults', adminVaultReplayRouter)

describe('Vault Outbox Replay', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('replayForVault service', () => {
    it('returns 0 when vault has no events in the outbox', async () => {
      mockDbQuery.whereRaw.mockReturnThis()
      mockDbQuery.orderBy.mockResolvedValueOnce([])

      const count = await replayForVault('vault-123')
      expect(count).toBe(0)
      expect(mockDbQuery.whereRaw).toHaveBeenCalledWith("payload->'data'->>'vaultId' = ?", ['vault-123'])
      expect(mockDbQuery.orderBy).toHaveBeenCalledWith('created_at', 'asc')
      expect(dispatchWebhookEvent).not.toHaveBeenCalled()
    })

    it('replays all events in order and returns the count', async () => {
      const mockEvents = [
        {
          id: 1,
          payload: JSON.stringify({
            eventId: 'evt-1',
            eventType: 'vault_created',
            data: { vaultId: 'vault-123' },
            organizationId: 'org-1',
          }),
        },
        {
          id: 2,
          payload: {
            eventId: 'evt-2',
            eventType: 'vault_completed',
            data: { vaultId: 'vault-123' },
            organizationId: 'org-1',
          },
        },
      ]

      mockDbQuery.whereRaw.mockReturnThis()
      mockDbQuery.orderBy.mockResolvedValueOnce(mockEvents)

      const count = await replayForVault('vault-123', 'sub-999')
      expect(count).toBe(2)
      expect(dispatchWebhookEvent).toHaveBeenCalledTimes(2)
      expect(dispatchWebhookEvent).toHaveBeenNthCalledWith(
        1,
        {
          eventId: 'evt-1',
          eventType: 'vault_created',
          data: { vaultId: 'vault-123' },
          organizationId: 'org-1',
        },
        'sub-999',
      )
      expect(dispatchWebhookEvent).toHaveBeenNthCalledWith(
        2,
        {
          eventId: 'evt-2',
          eventType: 'vault_completed',
          data: { vaultId: 'vault-123' },
          organizationId: 'org-1',
        },
        'sub-999',
      )
    })
  })

  describe('POST /api/admin/vaults/:id/replay-events route', () => {
    it('requires admin role and returns 403 for non-admin user', async () => {
      const res = await request(app)
        .post('/api/admin/vaults/vault-123/replay-events')
        .set('Authorization', 'Bearer user')
        .send()

      expect(res.status).toBe(403)
      expect(createAuditLog).not.toHaveBeenCalled()
    })

    it('requires authentication and returns 401 for unauthenticated request', async () => {
      const res = await request(app)
        .post('/api/admin/vaults/vault-123/replay-events')
        .send()

      expect(res.status).toBe(401)
      expect(createAuditLog).not.toHaveBeenCalled()
    })

    it('successfully triggers replay and writes audit log for admin', async () => {
      mockDbQuery.whereRaw.mockReturnThis()
      mockDbQuery.orderBy.mockResolvedValueOnce([
        {
          id: 1,
          payload: {
            eventId: 'evt-1',
            eventType: 'vault_created',
            data: { vaultId: 'vault-123' },
            organizationId: 'org-1',
          },
        },
      ])

      const res = await request(app)
        .post('/api/admin/vaults/vault-123/replay-events')
        .set('Authorization', 'Bearer admin')
        .send({ subscriber_id: 'sub-999' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ replayed: true, count: 1 })

      expect(createAuditLog).toHaveBeenCalledWith({
        actor_user_id: 'admin-1',
        action: 'vault.outbox.replay',
        target_type: 'vault',
        target_id: 'vault-123',
        metadata: {
          subscriberId: 'sub-999',
          replayedCount: 1,
        },
      })
    })

    it('returns 400 if subscriber_id is not a string', async () => {
      const res = await request(app)
        .post('/api/admin/vaults/vault-123/replay-events')
        .set('Authorization', 'Bearer admin')
        .send({ subscriber_id: 12345 })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'subscriber_id must be a string' })
      expect(createAuditLog).not.toHaveBeenCalled()
    })
  })
})

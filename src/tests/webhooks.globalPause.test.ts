/**
 * Tests for the guardian-gated global webhook-delivery pause switch.
 *
 * Covers:
 *  - pauseStore unit behaviour (isPaused / pauseDelivery / resumeDelivery)
 *  - outboxRelay short-circuits when paused (events stay in outbox)
 *  - GET /pause/status, POST /pause, POST /resume route semantics
 *  - Non-admin requests are rejected with 403
 *  - Audit log written on pause and resume
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'

// Ensure we don't try to connect to a real Redis in these tests unless we want to,
// but since we want predictable unit tests, we'll force the fallback memory flag.
const originalRedisUrl = process.env.REDIS_URL
process.env.REDIS_URL = ''

// ── All mocks must be declared before any await import() ─────────────────────

const createAuditLog = jest.fn()

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog,
  getAuditLogById: jest.fn(),
  listAuditLogs: jest.fn(),
}))

jest.unstable_mockModule('../db/knex.js', () => ({
  db: jest.fn(() => ({
    orderBy: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    first: jest.fn(async () => ({ total: 0 })),
  })),
}))

jest.unstable_mockModule('../db/index.js', () => ({
  db: jest.fn(),
}))

jest.unstable_mockModule('../services/webhooks.js', () => ({
  replayDeadLetter: jest.fn(),
  upsertSubscriber: jest.fn(),
  rotateSubscriberSecret: jest.fn(),
  listSubscribers: jest.fn(async () => []),
  dispatchWebhookEvent: jest.fn(async () => []),
}))

jest.unstable_mockModule('../repositories/etlBatchRepository.js', () => ({
  ETLBatchRepository: jest.fn(),
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

// ── Module-level imports (after mocks, so mocks apply) ────────────────────────

const { adminWebhooksRouter } = await import('../routes/adminWebhooks.js')
const { resetFallbackFlag } = await import('../services/pauseStore.js')

const app = express()
app.use(express.json())
app.use('/api/admin/webhooks', adminWebhooksRouter)

// ═════════════════════════════════════════════════════════════════════════════
// pauseStore unit tests
// ═════════════════════════════════════════════════════════════════════════════

describe('pauseStore', () => {
  beforeEach(() => {
    resetFallbackFlag()
  })
  afterEach(() => {
    resetFallbackFlag()
  })

  it('isPaused returns false initially', async () => {
    const { isPaused } = await import('../services/pauseStore.js')
    expect(await isPaused()).toBe(false)
  })

  it('pauseDelivery sets the flag', async () => {
    const { isPaused, pauseDelivery } = await import('../services/pauseStore.js')
    await pauseDelivery()
    expect(await isPaused()).toBe(true)
  })

  it('resumeDelivery unsets the flag', async () => {
    const { isPaused, pauseDelivery, resumeDelivery } = await import('../services/pauseStore.js')
    await pauseDelivery()
    expect(await isPaused()).toBe(true)
    await resumeDelivery()
    expect(await isPaused()).toBe(false)
  })

  it('resumeDelivery is idempotent when not paused', async () => {
    const { resumeDelivery, isPaused } = await import('../services/pauseStore.js')
    await expect(resumeDelivery()).resolves.not.toThrow()
    expect(await isPaused()).toBe(false)
  })

  it('pauseDelivery is idempotent when already paused', async () => {
    const { pauseDelivery, isPaused } = await import('../services/pauseStore.js')
    await pauseDelivery()
    await expect(pauseDelivery()).resolves.not.toThrow()
    expect(await isPaused()).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// outboxRelay: paused flag short-circuits dispatch
// ═════════════════════════════════════════════════════════════════════════════

describe('outboxRelay — paused state', () => {
  beforeEach(() => {
    resetFallbackFlag()
  })
  afterEach(() => {
    resetFallbackFlag()
  })

  it('returns 0 and skips dispatch when paused', async () => {
    const { pauseDelivery } = await import('../services/pauseStore.js')
    await pauseDelivery()

    const { relayOutboxBatch } = await import('../services/outboxRelay.js')
    const { dispatchWebhookEvent } = await import('../services/webhooks.js') as any

    const processed = await relayOutboxBatch()

    expect(processed).toBe(0)
    expect(dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HTTP routes
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/webhooks/pause/status', () => {
  beforeEach(() => {
    resetFallbackFlag()
  })
  afterEach(() => {
    resetFallbackFlag()
  })

  it('returns paused: false when flag is absent', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/pause/status')
      .set('Authorization', 'Bearer admin')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ paused: false })
  })

  it('returns paused: true when flag is present', async () => {
    const { pauseDelivery } = await import('../services/pauseStore.js')
    await pauseDelivery()
    const res = await request(app)
      .get('/api/admin/webhooks/pause/status')
      .set('Authorization', 'Bearer admin')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ paused: true })
  })

  it('rejects non-admin with 403', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/pause/status')
      .set('Authorization', 'Bearer user')
    expect(res.status).toBe(403)
  })

  it('rejects unauthenticated with 401', async () => {
    const res = await request(app).get('/api/admin/webhooks/pause/status')
    expect(res.status).toBe(401)
  })
})

describe('POST /api/admin/webhooks/pause', () => {
  beforeEach(() => { resetFallbackFlag(); createAuditLog.mockClear() })
  afterEach(() => { resetFallbackFlag() })

  it('creates the flag and returns paused: true', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/pause')
      .set('Authorization', 'Bearer admin')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ paused: true })
    const { isPaused } = await import('../services/pauseStore.js')
    expect(await isPaused()).toBe(true)
  })

  it('is idempotent — calling twice stays paused', async () => {
    await request(app).post('/api/admin/webhooks/pause').set('Authorization', 'Bearer admin')
    const res = await request(app)
      .post('/api/admin/webhooks/pause')
      .set('Authorization', 'Bearer admin')
    expect(res.status).toBe(200)
    expect(res.body.paused).toBe(true)
  })

  it('writes an audit log entry on pause', async () => {
    await request(app)
      .post('/api/admin/webhooks/pause')
      .set('Authorization', 'Bearer admin')
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'admin-1',
        action: 'webhook.delivery.paused',
        target_type: 'webhook_global',
      }),
    )
  })

  it('rejects non-admin with 403 and does not pause', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/pause')
      .set('Authorization', 'Bearer user')
    expect(res.status).toBe(403)
    const { isPaused } = await import('../services/pauseStore.js')
    expect(await isPaused()).toBe(false)
  })
})

describe('POST /api/admin/webhooks/resume', () => {
  beforeEach(() => { resetFallbackFlag(); createAuditLog.mockClear() })
  afterEach(() => { resetFallbackFlag() })

  it('removes the flag and returns paused: false', async () => {
    const { pauseDelivery } = await import('../services/pauseStore.js')
    await pauseDelivery()
    const res = await request(app)
      .post('/api/admin/webhooks/resume')
      .set('Authorization', 'Bearer admin')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ paused: false })
    const { isPaused } = await import('../services/pauseStore.js')
    expect(await isPaused()).toBe(false)
  })

  it('is idempotent — resuming when not paused is a no-op', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/resume')
      .set('Authorization', 'Bearer admin')
    expect(res.status).toBe(200)
    expect(res.body.paused).toBe(false)
  })

  it('writes an audit log entry on resume', async () => {
    const { pauseDelivery } = await import('../services/pauseStore.js')
    await pauseDelivery()
    await request(app)
      .post('/api/admin/webhooks/resume')
      .set('Authorization', 'Bearer admin')
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'admin-1',
        action: 'webhook.delivery.resumed',
        target_type: 'webhook_global',
      }),
    )
  })

  it('rejects non-admin with 403 and leaves flag in place', async () => {
    const { pauseDelivery } = await import('../services/pauseStore.js')
    await pauseDelivery()
    const res = await request(app)
      .post('/api/admin/webhooks/resume')
      .set('Authorization', 'Bearer user')
    expect(res.status).toBe(403)
    const { isPaused } = await import('../services/pauseStore.js')
    expect(await isPaused()).toBe(true)
  })
})

describe('pause → resume → status cycle', () => {
  beforeEach(() => { resetFallbackFlag() })
  afterEach(() => { resetFallbackFlag() })

  it('status transitions correctly through pause → resume', async () => {
    let res = await request(app)
      .get('/api/admin/webhooks/pause/status')
      .set('Authorization', 'Bearer admin')
    expect(res.body.paused).toBe(false)

    await request(app).post('/api/admin/webhooks/pause').set('Authorization', 'Bearer admin')

    res = await request(app)
      .get('/api/admin/webhooks/pause/status')
      .set('Authorization', 'Bearer admin')
    expect(res.body.paused).toBe(true)

    await request(app).post('/api/admin/webhooks/resume').set('Authorization', 'Bearer admin')

    res = await request(app)
      .get('/api/admin/webhooks/pause/status')
      .set('Authorization', 'Bearer admin')
    expect(res.body.paused).toBe(false)
  })
})

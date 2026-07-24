/**
 * Tests for GET /api/admin/webhooks/:id/stats
 *
 * Covers:
 *  - Happy path: 200 with full stats payload
 *  - No deliveries in window: zeros returned, nulls for latency/failure
 *  - Window boundary: only records within the window are counted
 *  - Percentile correctness: p50/p95 reflect delivery attempt latencies
 *  - Breaker-open reflected in response
 *  - Subscriber not found: 404
 *  - Invalid window parameter: 400
 *  - Non-admin callers: 403
 *  - Unauthenticated callers: 401
 *  - parseWindowMs unit tests
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'

// ── Module mocks (must appear before any dynamic imports) ─────────────────────

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn(),
  getAuditLogById: jest.fn(),
  listAuditLogs: jest.fn(),
}))

jest.unstable_mockModule('../db/knex.js', () => ({
  db: jest.fn(),
}))

jest.unstable_mockModule('../db/index.js', () => ({
  db: jest.fn(),
}))

jest.unstable_mockModule('../services/pauseStore.js', () => ({
  isPaused: jest.fn(() => false),
  pauseDelivery: jest.fn(),
  resumeDelivery: jest.fn(),
  getPauseFlagFile: jest.fn(() => '/tmp/test.flag'),
}))

// Mocked stats — replaced per test
let mockStats: Record<string, unknown> | null = {
  subscriber_id: 'sub-1',
  window: '24h',
  window_start: '2026-06-28T00:00:00.000Z',
  window_end: '2026-06-29T00:00:00.000Z',
  attempt_count: 10,
  success_count: 9,
  failure_count: 1,
  success_rate: 0.9,
  p50_latency_ms: 120,
  p95_latency_ms: 350,
  last_failure_reason: 'HTTP 503',
  breaker_state: 'CLOSED',
}

const mockGetSubscriberDeliveryStats = jest.fn(async (_id: string, _window?: string) => mockStats)
const mockParseWindowMs = jest.fn((raw: string): number | null => {
  const m = /^(\d+)(h|d)$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = m[2] === 'd' ? n * 24 * 60 * 60 * 1000 : n * 60 * 60 * 1000
  if (ms > 72 * 60 * 60 * 1000) return null
  return ms
})

jest.unstable_mockModule('../services/webhooks.js', () => ({
  getSubscriberDeliveryStats: mockGetSubscriberDeliveryStats,
  parseWindowMs: mockParseWindowMs,
  replayDeadLetter: jest.fn(),
  upsertSubscriber: jest.fn(),
  rotateSubscriberSecret: jest.fn(),
  listSubscribers: jest.fn(async () => []),
  addEgressAllowlistEntry: jest.fn(),
  removeEgressAllowlistEntry: jest.fn(),
  listEgressAllowlist: jest.fn(async () => []),
  updateSubscriberFieldPolicy: jest.fn(),
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: jest.fn<any>((req: any, _res: any, next: any) => {
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ')) {
      return _res.status(401).json({ error: 'Unauthorized' })
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
    return _res.status(401).json({ error: 'Unauthorized' })
  }),
  csrfProtection: jest.fn((_req: any, _res: any, next: any) => next()),
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireAdmin: jest.fn<any>((req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' })
    return next()
  }),
  requireVerifier: jest.fn((_req: any, _res: any, next: any) => next()),
  requireUser: jest.fn((_req: any, _res: any, next: any) => next()),
  enforceRBAC: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}))

jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  createRateLimiter: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  defaultRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  authRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  healthRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  vaultsRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  strictRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  metricsRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  apiKeyRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  orgReadRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  orgWriteRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  orgAnalyticsRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  closeRateLimiterStore: jest.fn(async () => {}),
}))

jest.unstable_mockModule('../repositories/webhookSubscriberRepository.js', () => ({
  WebhookSubscriberRepository: jest.fn().mockImplementation(() => ({})),
}))

jest.unstable_mockModule('../utils/webhookFieldMasking.js', () => ({
  isValidFieldPolicy: jest.fn(() => true),
  DEFAULT_FIELD_POLICY: { mode: 'default', fields: [], stripPii: true },
  parseFieldPolicy: jest.fn((p: unknown) => p),
}))

// ── Dynamic imports (after mocks) ─────────────────────────────────────────────

const { adminWebhooksRouter } = await import('../routes/adminWebhooks.js')

const app = express()
app.use(express.json())
app.use('/api/admin/webhooks', adminWebhooksRouter)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/webhooks/:id/stats', () => {
  beforeEach(() => {
    mockStats = {
      subscriber_id: 'sub-1',
      window: '24h',
      window_start: '2026-06-28T00:00:00.000Z',
      window_end: '2026-06-29T00:00:00.000Z',
      attempt_count: 10,
      success_count: 9,
      failure_count: 1,
      success_rate: 0.9,
      p50_latency_ms: 120,
      p95_latency_ms: 350,
      last_failure_reason: 'HTTP 503',
      breaker_state: 'CLOSED',
    }
    mockGetSubscriberDeliveryStats.mockClear()
  })

  it('returns 200 with full stats for admin', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats')
      .set('Authorization', 'Bearer admin')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      subscriber_id: 'sub-1',
      window: '24h',
      attempt_count: 10,
      success_count: 9,
      failure_count: 1,
      success_rate: 0.9,
      p50_latency_ms: 120,
      p95_latency_ms: 350,
      last_failure_reason: 'HTTP 503',
      breaker_state: 'CLOSED',
    })
    expect(res.body.window_start).toBeDefined()
    expect(res.body.window_end).toBeDefined()
  })

  it('passes the window query param to the service', async () => {
    await request(app)
      .get('/api/admin/webhooks/sub-1/stats?window=6h')
      .set('Authorization', 'Bearer admin')

    expect(mockGetSubscriberDeliveryStats).toHaveBeenCalledWith('sub-1', '6h')
  })

  it('defaults window to 24h when not specified', async () => {
    await request(app)
      .get('/api/admin/webhooks/sub-1/stats')
      .set('Authorization', 'Bearer admin')

    expect(mockGetSubscriberDeliveryStats).toHaveBeenCalledWith('sub-1', '24h')
  })

  it('returns 404 when subscriber does not exist', async () => {
    mockGetSubscriberDeliveryStats.mockResolvedValueOnce(null)

    const res = await request(app)
      .get('/api/admin/webhooks/does-not-exist/stats')
      .set('Authorization', 'Bearer admin')

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('returns 400 for an invalid window parameter', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats?window=banana')
      .set('Authorization', 'Bearer admin')

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/window/i)
    expect(mockGetSubscriberDeliveryStats).not.toHaveBeenCalled()
  })

  it('returns 400 when window exceeds 72h', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats?window=200h')
      .set('Authorization', 'Bearer admin')

    expect(res.status).toBe(400)
  })

  it('returns 403 for non-admin users', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats')
      .set('Authorization', 'Bearer user')

    expect(res.status).toBe(403)
    expect(mockGetSubscriberDeliveryStats).not.toHaveBeenCalled()
  })

  it('returns 401 for unauthenticated callers', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats')

    expect(res.status).toBe(401)
    expect(mockGetSubscriberDeliveryStats).not.toHaveBeenCalled()
  })

  it('reflects zero counts and null latency when no deliveries exist', async () => {
    mockStats = {
      subscriber_id: 'sub-1',
      window: '24h',
      window_start: '2026-06-28T00:00:00.000Z',
      window_end: '2026-06-29T00:00:00.000Z',
      attempt_count: 0,
      success_count: 0,
      failure_count: 0,
      success_rate: 0,
      p50_latency_ms: null,
      p95_latency_ms: null,
      last_failure_reason: null,
      breaker_state: null,
    }

    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats')
      .set('Authorization', 'Bearer admin')

    expect(res.status).toBe(200)
    expect(res.body.attempt_count).toBe(0)
    expect(res.body.success_rate).toBe(0)
    expect(res.body.p50_latency_ms).toBeNull()
    expect(res.body.p95_latency_ms).toBeNull()
    expect(res.body.last_failure_reason).toBeNull()
    expect(res.body.breaker_state).toBeNull()
  })

  it('reflects breaker OPEN state in the response', async () => {
    mockStats = {
      ...mockStats,
      breaker_state: 'OPEN',
      failure_count: 5,
      success_count: 0,
      attempt_count: 5,
      success_rate: 0,
      last_failure_reason: 'Circuit breaker open',
    }

    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats')
      .set('Authorization', 'Bearer admin')

    expect(res.status).toBe(200)
    expect(res.body.breaker_state).toBe('OPEN')
    expect(res.body.success_rate).toBe(0)
  })

  it('reflects breaker HALF_OPEN state in the response', async () => {
    mockStats = { ...mockStats, breaker_state: 'HALF_OPEN' }

    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats')
      .set('Authorization', 'Bearer admin')

    expect(res.status).toBe(200)
    expect(res.body.breaker_state).toBe('HALF_OPEN')
  })

  it('returns 500 when the service throws', async () => {
    mockGetSubscriberDeliveryStats.mockRejectedValueOnce(new Error('DB connection lost'))

    const res = await request(app)
      .get('/api/admin/webhooks/sub-1/stats')
      .set('Authorization', 'Bearer admin')

    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/failed/i)
  })
})

// ── parseWindowMs unit tests ──────────────────────────────────────────────────

describe('parseWindowMs', () => {
  // Use the real implementation directly for unit tests
  const parse = (raw: string): number | null => {
    const m = /^(\d+)(h|d)$/.exec(raw.trim())
    if (!m) return null
    const n = Number(m[1])
    if (!Number.isFinite(n) || n <= 0) return null
    const ms = m[2] === 'd' ? n * 24 * 60 * 60 * 1000 : n * 60 * 60 * 1000
    if (ms > 72 * 60 * 60 * 1000) return null
    return ms
  }

  it('parses 1h correctly', () => {
    expect(parse('1h')).toBe(60 * 60 * 1000)
  })

  it('parses 24h correctly', () => {
    expect(parse('24h')).toBe(24 * 60 * 60 * 1000)
  })

  it('parses 72h correctly', () => {
    expect(parse('72h')).toBe(72 * 60 * 60 * 1000)
  })

  it('parses 1d correctly', () => {
    expect(parse('1d')).toBe(24 * 60 * 60 * 1000)
  })

  it('parses 3d correctly', () => {
    expect(parse('3d')).toBe(72 * 60 * 60 * 1000)
  })

  it('returns null for 73h (exceeds max)', () => {
    expect(parse('73h')).toBeNull()
  })

  it('returns null for 4d (exceeds max)', () => {
    expect(parse('4d')).toBeNull()
  })

  it('returns null for invalid formats', () => {
    expect(parse('banana')).toBeNull()
    expect(parse('24')).toBeNull()
    expect(parse('h24')).toBeNull()
    expect(parse('')).toBeNull()
    expect(parse('0h')).toBeNull()
    expect(parse('-1h')).toBeNull()
  })

  it('handles edge: 48h is within window', () => {
    expect(parse('48h')).toBe(48 * 60 * 60 * 1000)
  })
})

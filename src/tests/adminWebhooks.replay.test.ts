import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'

// ── In-memory stores ──────────────────────────────────────────────────────────

const subscribers = new Map<string, any>()
const deadLetters: any[] = []
const replayMarkers = new Map<string, any>()

let nextReplayMarkerId = 0

const resetStores = () => {
  subscribers.clear()
  deadLetters.length = 0
  replayMarkers.clear()
  nextReplayMarkerId = 0
}

// ── Build a subscriber helper ─────────────────────────────────────────────────

const addTestSubscriber = (overrides: Record<string, any> = {}) => {
  const sub = {
    id: randomUUID(),
    organizationId: 'org-1',
    url: 'https://hooks.example.com/cb',
    secret: 'test-secret',
    previousSecret: null,
    rotatedAt: null,
    events: [],
    active: true,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  subscribers.set(sub.id, sub)
  return sub
}

// ── Add dead letters helper ───────────────────────────────────────────────────

const addDeadLetter = (subscriberId: string, overrides: Record<string, any> = {}) => {
  const dl = {
    id: randomUUID(),
    subscriber_id: subscriberId,
    event_id: `evt-${deadLetters.length}`,
    event_type: 'vault_created',
    payload: { eventId: `evt-${deadLetters.length}`, eventType: 'vault_created', timestamp: new Date().toISOString(), data: { vaultId: 'v-1' }, organizationId: 'org-1' },
    last_error: 'HTTP 503',
    attempts: 3,
    failed_at: '2026-06-27T12:00:00.000Z',
    replayed_at: null,
    ...overrides,
  }
  deadLetters.push(dl)
  return dl
}

// ── Mock DB ───────────────────────────────────────────────────────────────────

const buildQuery = (table: string) => {
  const q: any = {
    _table: table,
    _filters: {},
    _data: null,
    _orderBy: null,
    _limit: null,
    _offset: null,
    _returning: null,

    clone() { return q },
    count(field: string) {
      q._countField = field
      return q
    },

    where(filter: Record<string, any> | string, opOrVal?: any, val?: any) {
      if (typeof filter === 'string') {
        if (arguments.length === 3) {
          const key = `__where_${filter}_${opOrVal}`
          q._filters[key] = val
        } else {
          q._filters[filter] = opOrVal
        }
      } else {
        Object.assign(q._filters, filter)
      }
      return q
    },
    whereIn() { return q },
    select() { return q },
    first() { q._first = true; q._limit = 1; return q },
    orderBy(field: string, dir?: string) { q._orderBy = field; q._orderByDir = dir; return q },
    limit(n: number) { q._limit = n; return q },
    offset() { return q },
    insert(data: any) { q._data = data; q._isInsert = true; return q },
    update(data: any) { q._data = data; q._isUpdate = true; return q },
    onConflict() { return q },
    merge() { return q },

    returning(fields: any) {
      q._returning = fields
      return q
    },

    del() { return q },

    async then(resolve: (v: any) => any) {
      if (q._table === 'webhook_replay_markers') {
        // Handle updates
        if (q._isUpdate && q._data) {
          const markerId = q._filters.id
          for (const [key, marker] of replayMarkers) {
            if (marker.id === markerId) {
              Object.assign(marker, q._data)
              break
            }
          }
          return Promise.resolve([1]).then(resolve)
        }

        const markerKey = q._filters.replay_marker
        if (markerKey && !q._data) {
          const existing = replayMarkers.get(markerKey)
          if (q._first) {
            return Promise.resolve(existing ?? null).then(resolve)
          }
          return Promise.resolve(existing ? [existing] : []).then(resolve)
        }
        if (q._data) {
          const marker = {
            id: `marker-${++nextReplayMarkerId}`,
            subscriber_id: q._data.subscriber_id,
            start_time: q._data.start_time,
            end_time: q._data.end_time,
            replay_marker: q._data.replay_marker,
            status: q._data.status ?? 'in_progress',
            total_count: q._data.total_count ?? 0,
            success_count: 0,
            failure_count: 0,
            errors: null,
            created_at: new Date(),
            completed_at: null,
          }
          replayMarkers.set(marker.replay_marker, marker)
          if (q._returning) {
            return Promise.resolve([marker]).then(resolve)
          }
          return Promise.resolve([marker]).then(resolve)
        }
        const rows = [...replayMarkers.values()]
          .filter((m) => m.replay_marker === q._filters.replay_marker)
        return Promise.resolve(rows).then(resolve)
      }

      if (q._table === 'webhook_dead_letters') {
        // Handle update
        if (q._isUpdate && q._data) {
          return Promise.resolve([1]).then(resolve)
        }
        if (q._isInsert && q._data) {
          return Promise.resolve([true]).then(resolve)
        }
        const filterSubId = q._filters.subscriber_id
        const filterStart = q._filters['__where_failed_at_>=']
        const filterEnd = q._filters['__where_failed_at_<=']
        let rows = [...deadLetters]
        if (filterSubId) rows = rows.filter((r) => r.subscriber_id === filterSubId)
        if (filterStart) rows = rows.filter((r) => new Date(r.failed_at) >= new Date(filterStart))
        if (filterEnd) rows = rows.filter((r) => new Date(r.failed_at) <= new Date(filterEnd))
        if (q._orderBy === 'failed_at' && q._orderByDir !== 'desc') {
          rows.sort((a, b) => new Date(a.failed_at).getTime() - new Date(b.failed_at).getTime())
        }
        if (q._limit) rows = rows.slice(0, q._limit)
        return Promise.resolve(rows).then(resolve)
      }

      return Promise.resolve([]).then(resolve)
    },
  }
  return q
}

const mockDb: any = jest.fn((table: string) => buildQuery(table))
mockDb.fn = { now: () => new Date() }
mockDb.raw = jest.fn()

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.unstable_mockModule('../config/env.js', () => ({
  getEnv: jest.fn(() => ({
    DATABASE_URL: 'postgresql://localhost/test',
    REDIS_URL: undefined,
    JWT_SECRET: 'test-secret',
    NODE_ENV: 'test',
    CORS_ORIGINS: '*',
    PORT: 0,
    HOST: 'localhost',
  })),
  initEnv: jest.fn(() => ({ env: {}, warnings: [] })),
  _resetEnvForTesting: jest.fn(),
}))

jest.unstable_mockModule('../db/index.js', () => ({ db: mockDb }))

jest.unstable_mockModule('../db/knex.js', () => ({
  db: mockDb,
  closeDatabase: jest.fn(),
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn(),
  getAuditLogById: jest.fn(),
  listAuditLogs: jest.fn(),
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

jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  defaultRateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
  authRateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
  healthRateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
  vaultsRateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
  strictRateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
  metricsRateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
  apiKeyRateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
  createRateLimiter: jest.fn(() => jest.fn<any>((_req: any, _res: any, next: any) => next())),
}))

jest.unstable_mockModule('../repositories/webhookSubscriberRepository.js', () => ({
  WebhookSubscriberRepository: jest.fn().mockImplementation(() => ({
    findByOrg: jest.fn(async () => []),
    findByEvent: jest.fn(async () => []),
    findById: jest.fn(async (id: string) => {
      const sub = subscribers.get(id)
      return sub ?? null
    }),
    create: jest.fn(),
    upsert: jest.fn(),
    remove: jest.fn(),
    getBreakerState: jest.fn(async () => null),
    upsertBreakerState: jest.fn(async () => {}),
    tryTransitionToHalfOpen: jest.fn(async () => false),
    removeBreakerState: jest.fn(async () => true),
    getAllBreakerStates: jest.fn(async () => []),
  })),
}))

// ── Load SUT ──────────────────────────────────────────────────────────────────

const { adminWebhooksRouter } = await import('../routes/adminWebhooks.js')

const app = express()
app.use(express.json())
app.use('/api/admin/webhooks', adminWebhooksRouter)

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/webhooks/:id/replay', () => {
  beforeEach(() => {
    resetStores()
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete (global as any).fetch
  })

  const mockFetchSuccess = () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      ok: true,
    } as Response)
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/some-id/replay')
      .send({ start_time: '2026-06-27T00:00:00.000Z', end_time: '2026-06-28T00:00:00.000Z' })
    expect(res.status).toBe(401)
  })

  it('rejects non-admin requests with 403', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/some-id/replay')
      .set('Authorization', 'Bearer user')
      .send({ start_time: '2026-06-27T00:00:00.000Z', end_time: '2026-06-28T00:00:00.000Z' })
    expect(res.status).toBe(403)
  })

  it('returns 400 when start_time is missing', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/some-id/replay')
      .set('Authorization', 'Bearer admin')
      .send({ end_time: '2026-06-28T00:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/start_time/i)
  })

  it('returns 400 when end_time is missing', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/some-id/replay')
      .set('Authorization', 'Bearer admin')
      .send({ start_time: '2026-06-27T00:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/end_time/i)
  })

  it('returns 400 when replay_marker is not a string', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/some-id/replay')
      .set('Authorization', 'Bearer admin')
      .send({
        start_time: '2026-06-27T00:00:00.000Z',
        end_time: '2026-06-28T00:00:00.000Z',
        replay_marker: 123,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/replay_marker/)
  })

  it('returns 400 when max_events is not a positive integer', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/some-id/replay')
      .set('Authorization', 'Bearer admin')
      .send({
        start_time: '2026-06-27T00:00:00.000Z',
        end_time: '2026-06-28T00:00:00.000Z',
        max_events: -1,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/max_events/)
  })

  it('returns 404 when subscriber does not exist', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/non-existent-id/replay')
      .set('Authorization', 'Bearer admin')
      .send({ start_time: '2026-06-27T00:00:00.000Z', end_time: '2026-06-28T00:00:00.000Z' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('returns empty result when no dead letters match the time window', async () => {
    const sub = addTestSubscriber()

    const res = await request(app)
      .post(`/api/admin/webhooks/${sub.id}/replay`)
      .set('Authorization', 'Bearer admin')
      .send({ start_time: '2026-06-27T00:00:00.000Z', end_time: '2026-06-28T00:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      replayed: true,
      count: 0,
      success_count: 0,
      failure_count: 0,
    })
  })

  it('replays dead letters within the time window', async () => {
    mockFetchSuccess()
    const sub = addTestSubscriber()
    addDeadLetter(sub.id, {
      event_id: 'replay-me-1',
      failed_at: '2026-06-27T12:00:00.000Z',
    })
    addDeadLetter(sub.id, {
      event_id: 'replay-me-2',
      failed_at: '2026-06-27T14:00:00.000Z',
    })
    // Outside window — should not be picked up
    addDeadLetter(sub.id, {
      event_id: 'outside-window',
      failed_at: '2026-06-26T12:00:00.000Z',
    })

    const res = await request(app)
      .post(`/api/admin/webhooks/${sub.id}/replay`)
      .set('Authorization', 'Bearer admin')
      .send({
        start_time: '2026-06-27T00:00:00.000Z',
        end_time: '2026-06-28T00:00:00.000Z',
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      replayed: true,
      count: 2,
      success_count: 2,
      failure_count: 0,
    })
  })

  it('rate-bounds replay to max_events', async () => {
    mockFetchSuccess()
    const sub = addTestSubscriber()
    for (let i = 0; i < 10; i++) {
      addDeadLetter(sub.id, {
        event_id: `evt-${i}`,
        failed_at: '2026-06-27T12:00:00.000Z',
      })
    }

    const res = await request(app)
      .post(`/api/admin/webhooks/${sub.id}/replay`)
      .set('Authorization', 'Bearer admin')
      .send({
        start_time: '2026-06-27T00:00:00.000Z',
        end_time: '2026-06-28T00:00:00.000Z',
        max_events: 3,
      })

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(3)
    expect(res.body.success_count).toBe(3)
  })

  it('is idempotent with a replay marker', async () => {
    mockFetchSuccess()
    const sub = addTestSubscriber()
    addDeadLetter(sub.id, {
      event_id: 'idempotent-evt',
      failed_at: '2026-06-27T12:00:00.000Z',
    })

    const marker = 'my-replay-marker-1'

    // First call — should replay
    const res1 = await request(app)
      .post(`/api/admin/webhooks/${sub.id}/replay`)
      .set('Authorization', 'Bearer admin')
      .send({
        start_time: '2026-06-27T00:00:00.000Z',
        end_time: '2026-06-28T00:00:00.000Z',
        replay_marker: marker,
      })

    expect(res1.status).toBe(200)
    expect(res1.body.replayed).toBe(true)
    expect(res1.body.count).toBe(1)
    expect(res1.body.replay_marker).toBe(marker)

    // Second call with same marker — should return cached result without re-sending
    const res2 = await request(app)
      .post(`/api/admin/webhooks/${sub.id}/replay`)
      .set('Authorization', 'Bearer admin')
      .send({
        start_time: '2026-06-27T00:00:00.000Z',
        end_time: '2026-06-28T00:00:00.000Z',
        replay_marker: marker,
      })

    expect(res2.status).toBe(200)
    expect(res2.body.replayed).toBe(true)
    expect(res2.body.count).toBe(1)
    expect(res2.body.replay_marker).toBe(marker)
  })

  it('writes an audit log entry on successful replay', async () => {
    mockFetchSuccess()
    const { createAuditLog } = await import('../lib/audit-logs.js')
    const sub = addTestSubscriber()
    addDeadLetter(sub.id, {
      event_id: 'audit-evt',
      failed_at: '2026-06-27T12:00:00.000Z',
    })

    await request(app)
      .post(`/api/admin/webhooks/${sub.id}/replay`)
      .set('Authorization', 'Bearer admin')
      .send({
        start_time: '2026-06-27T00:00:00.000Z',
        end_time: '2026-06-28T00:00:00.000Z',
      })

    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'admin-1',
        action: 'webhook.window_replay',
        target_type: 'webhook_subscriber',
        target_id: sub.id,
      }),
    )
  })
})

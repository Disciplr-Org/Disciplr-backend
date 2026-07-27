import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// ── unit tests for dbMetrics ring buffer helpers ──────────────────────────────
import {
  fingerprintSql,
  captureSlowQuery,
  getSlowQueryBuffer,
  resetSlowQueryBuffer,
  SlowQueryEntry,
} from '../services/dbMetrics.js'

describe('fingerprintSql', () => {
  it('replaces quoted string literals with ?', () => {
    expect(fingerprintSql("select * from users where name = 'Alice'")).toBe(
      'select * from users where name = ?'
    )
  })

  it('replaces integer literals with ?', () => {
    expect(fingerprintSql('select * from vaults where id = 42')).toBe(
      'select * from vaults where id = ?'
    )
  })

  it('replaces float literals with ?', () => {
    expect(fingerprintSql('select * from prices where amount = 3.14')).toBe(
      'select * from prices where amount = ?'
    )
  })

  it('replaces $N positional params with ?', () => {
    expect(fingerprintSql('select * from users where id = $1 and org = $2')).toBe(
      'select * from users where id = ? and org = ?'
    )
  })

  it('collapses whitespace', () => {
    expect(fingerprintSql('select  *   from   users')).toBe('select * from users')
  })

  it('truncates to 200 characters', () => {
    const long = 'select ' + 'x'.repeat(300)
    expect(fingerprintSql(long).length).toBeLessThanOrEqual(200)
  })

  it('never contains raw PII-like values', () => {
    const sql = "select * from users where email = 'user@example.com' and id = 99"
    const fp = fingerprintSql(sql)
    expect(fp).not.toContain('user@example.com')
    expect(fp).not.toContain('99')
  })
})

describe('slow-query ring buffer (unit)', () => {
  const origThreshold = process.env.SLOW_QUERY_THRESHOLD_MS
  const origSize = process.env.SLOW_QUERY_BUFFER_SIZE

  beforeEach(() => {
    resetSlowQueryBuffer()
  })

  afterEach(() => {
    if (origThreshold === undefined) delete process.env.SLOW_QUERY_THRESHOLD_MS
    else process.env.SLOW_QUERY_THRESHOLD_MS = origThreshold
    if (origSize === undefined) delete process.env.SLOW_QUERY_BUFFER_SIZE
    else process.env.SLOW_QUERY_BUFFER_SIZE = origSize
    resetSlowQueryBuffer()
  })

  it('returns empty array when no queries captured', () => {
    expect(getSlowQueryBuffer()).toEqual([])
  })

  it('captures a query that meets the threshold', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '100'
    captureSlowQuery('select * from vaults', 150)
    const buf = getSlowQueryBuffer()
    expect(buf).toHaveLength(1)
    expect(buf[0].durationMs).toBe(150)
    expect(buf[0].fingerprint).toBe('select * from vaults')
    expect(buf[0].capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('ignores queries below threshold (exclusive)', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '200'
    captureSlowQuery('select 1', 199)
    expect(getSlowQueryBuffer()).toHaveLength(0)
  })

  it('captures queries exactly at the threshold', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '200'
    captureSlowQuery('select 1', 200)
    expect(getSlowQueryBuffer()).toHaveLength(1)
  })

  it('evicts oldest entry when buffer is full (ring behaviour)', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0'
    process.env.SLOW_QUERY_BUFFER_SIZE = '3'
    resetSlowQueryBuffer()

    captureSlowQuery('select a', 10)
    captureSlowQuery('select b', 20)
    captureSlowQuery('select c', 30)
    // Buffer full — next write overwrites oldest (select a)
    captureSlowQuery('select d', 40)

    const buf = getSlowQueryBuffer()
    expect(buf).toHaveLength(3)
    const durations = buf.map((e) => e.durationMs).sort((a, b) => a - b)
    expect(durations).toEqual([20, 30, 40])
  })

  it('stores entries in oldest-to-newest order', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0'
    process.env.SLOW_QUERY_BUFFER_SIZE = '5'
    resetSlowQueryBuffer()

    captureSlowQuery('select * from a', 10)
    captureSlowQuery('select * from b', 20)
    captureSlowQuery('select * from c', 30)

    const buf = getSlowQueryBuffer()
    expect(buf[0].durationMs).toBe(10)
    expect(buf[1].durationMs).toBe(20)
    expect(buf[2].durationMs).toBe(30)
  })

  it('strips raw parameter values (no PII in fingerprint)', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0'
    resetSlowQueryBuffer()
    captureSlowQuery("select * from users where email = 'bob@example.com' and id = $1", 500)
    const buf = getSlowQueryBuffer()
    expect(buf[0].fingerprint).not.toContain('bob@example.com')
    expect(buf[0].fingerprint).not.toContain('$1')
  })

  it('resets the buffer', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0'
    resetSlowQueryBuffer()
    captureSlowQuery('select 1', 10)
    resetSlowQueryBuffer()
    expect(getSlowQueryBuffer()).toHaveLength(0)
  })
})

// ── HTTP endpoint tests ───────────────────────────────────────────────────────
import express, { Express } from 'express'
import request from 'supertest'

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (_req: any, _res: any, next: any) => {
    _req.user = { userId: 'admin-1', role: 'admin' }
    next()
  },
}))
jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}))
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  metricsRateLimiter: (_req: any, _res: any, next: any) => next(),
}))
jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: any, _res: any, next: any) => next(),
}))
jest.unstable_mockModule('../middleware/queryParser.js', () => ({
  queryParser: () => (_req: any, _res: any, next: any) => next(),
}))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: async () => ({ id: 'log-1', created_at: new Date().toISOString() }),
  listAuditLogs: async () => [],
  getAuditLogById: async () => null,
  exportAuditLogsForOrganization: async () => ({}),
  verifyAuditLogChain: async () => ({ verified: true }),
}))
jest.unstable_mockModule('../services/vaultStore.js', () => ({
  cancelVaultById: async () => ({ error: 'not_found' }),
}))
jest.unstable_mockModule('../services/dbMetrics.js', () => ({
  getDBHealthMetrics: () => ({
    pool: { timestamp: new Date(), availableConnections: 5, waitingClients: 0, totalConnections: 5, poolSize: { min: 2, max: 10 } },
    slowQueries: [],
    isHealthy: true,
    warnings: [],
  }),
  getSlowQueryBuffer: jest.fn<any>(() => []),
}))
jest.unstable_mockModule('../services/featureFlags.js', () => ({
  getFlag: () => false,
  setFlag: () => {},
  getAllFlags: () => ({}),
  isValidFeatureFlag: () => false,
  FeatureFlag: {},
}))
jest.unstable_mockModule('../db/index.js', () => ({ pool: {} }))
jest.unstable_mockModule('../db/knex.js', () => ({
  db: {
    select: () => ({ where: () => ({ first: async () => null }) }),
    count: () => ({ where: () => [{ total: '0' }] }),
    on: () => {},
  },
}))
jest.unstable_mockModule('../security/abuse-monitor.js', () => ({
  getAbuseCategoryCounts: () => ({}),
}))
jest.unstable_mockModule('../services/checkpointStore.js', () => ({
  CheckpointStore: class { getAllCheckpoints = async () => [] },
}))
jest.unstable_mockModule('../services/monitor.js', () => ({
  getLatestListenerLag: () => null,
}))
jest.unstable_mockModule('../lib/auth-utils.js', () => ({
  generateImpersonationToken: () => 'tok',
}))
jest.unstable_mockModule('../lib/prismaScope.js', () => ({
  getPrisma: () => ({ user: { findUnique: async () => null } }),
}))
jest.unstable_mockModule('../services/session.js', () => ({
  forceRevokeUserSessions: async () => {},
  recordSession: async () => {},
}))
jest.unstable_mockModule('../services/user.service.js', () => ({
  userService: {
    listUsers: async () => ({ users: [], total: 0 }),
    getUserById: async () => null,
    updateUserRole: async () => null,
    updateUserStatus: async () => null,
    softDeleteUser: async () => null,
    hardDeleteUser: async () => null,
    restoreUser: async () => null,
  },
  DeleteResult: {},
}))

describe('GET /api/admin/db/slow-queries (HTTP)', () => {
  let app: Express
  let mockGetSlowQueryBuffer: ReturnType<typeof jest.fn>

  beforeEach(async () => {
    resetSlowQueryBuffer()
    const dbMetrics = await import('../services/dbMetrics.js')
    mockGetSlowQueryBuffer = (dbMetrics as any).getSlowQueryBuffer as ReturnType<typeof jest.fn>

    const { adminRouter } = await import('../routes/admin.js')
    app = express()
    app.use(express.json())
    app.use('/api/admin', adminRouter)
  })

  it('returns 200 with empty entries when buffer is empty', async () => {
    mockGetSlowQueryBuffer.mockReturnValue([])
    const res = await request(app).get('/api/admin/db/slow-queries')
    expect(res.status).toBe(200)
    expect(res.body.data.count).toBe(0)
    expect(res.body.data.entries).toEqual([])
    expect(typeof res.body.data.thresholdMs).toBe('number')
    expect(typeof res.body.data.bufferSize).toBe('number')
  })

  it('returns buffered entries with correct shape', async () => {
    const entries: SlowQueryEntry[] = [
      { fingerprint: 'select * from vaults where id = ?', durationMs: 312, capturedAt: '2026-06-28T00:00:01.000Z' },
      { fingerprint: 'select * from transactions where user_id = ?', durationMs: 485, capturedAt: '2026-06-28T00:00:05.000Z' },
    ]
    mockGetSlowQueryBuffer.mockReturnValue(entries)
    const res = await request(app).get('/api/admin/db/slow-queries')
    expect(res.status).toBe(200)
    expect(res.body.data.count).toBe(2)
    expect(res.body.data.entries).toHaveLength(2)
    expect(res.body.data.entries[0].fingerprint).toBe(entries[0].fingerprint)
    expect(res.body.data.entries[0].durationMs).toBe(312)
    expect(res.body.data.entries[1].durationMs).toBe(485)
  })

  it('entries contain no raw parameter values', async () => {
    const entries: SlowQueryEntry[] = [
      { fingerprint: 'select * from users where id = ?', durationMs: 250, capturedAt: new Date().toISOString() },
    ]
    mockGetSlowQueryBuffer.mockReturnValue(entries)
    const res = await request(app).get('/api/admin/db/slow-queries')
    const fp: string = res.body.data.entries[0].fingerprint
    expect(fp).not.toMatch(/'[^']*'/)
    expect(fp).not.toMatch(/\$\d+/)
  })

  it('exposes thresholdMs and bufferSize from env', async () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '300'
    process.env.SLOW_QUERY_BUFFER_SIZE = '50'
    mockGetSlowQueryBuffer.mockReturnValue([])
    const res = await request(app).get('/api/admin/db/slow-queries')
    expect(res.body.data.thresholdMs).toBe(300)
    expect(res.body.data.bufferSize).toBe(50)
    delete process.env.SLOW_QUERY_THRESHOLD_MS
    delete process.env.SLOW_QUERY_BUFFER_SIZE
  })
})

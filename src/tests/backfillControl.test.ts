/**
 * Tests for backfill progress/pause/resume (issue #842).
 *
 * HTTP route tests use jest.unstable_mockModule (required for ESM) with a
 * standalone Express app. Service/unit tests use in-memory fakes directly.
 */
import express from 'express'
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import request from 'supertest'
import {
  reindexEvidenceBatch,
  runReindexBatches,
  type MilestoneEmbeddingSource,
  type ReindexCursorStore,
} from '../services/evidenceReindex.js'
import { DeterministicEmbeddingProvider } from '../services/embeddingProvider.js'
import { UserRole } from '../types/user.js'

// ── ESM-compatible mocks ──────────────────────────────────────────────────────

let _listProgressResult: any = []
let _pauseResult: any = undefined
let _resumeResult: any = undefined

const listProgressFn = jest.fn<any>(async () => _listProgressResult)
const pauseFn = jest.fn<any>(async () => _pauseResult)
const resumeFn = jest.fn<any>(async () => _resumeResult)
const createAuditLogFn = jest.fn<any>(async () => ({ id: 'audit-123' }))

jest.unstable_mockModule('../services/backfillCursorStore.js', () => ({
  BackfillCursorStore: class {
    listProgress = listProgressFn
    pause = pauseFn
    resume = resumeFn
  },
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: createAuditLogFn,
  getAuditLogById: jest.fn<any>(),
  listAuditLogs: jest.fn<any>(),
  verifyAuditLogChain: jest.fn<any>(),
  exportAuditLogsForOrganization: jest.fn<any>(),
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      // Decode JWT payload without verification for test purposes
      const payload = JSON.parse(Buffer.from(auth.slice(7).split('.')[1], 'base64url').toString())
      req.user = { userId: payload.userId, role: payload.role }
      next()
    } catch { res.status(401).json({ error: 'Unauthorized' }) }
  },
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.user?.role !== UserRole.ADMIN) { res.status(403).json({ error: 'Forbidden' }); return }
    next()
  },
}))

// Stub out all the other admin.ts dependencies so the router loads cleanly
jest.unstable_mockModule('../db/knex.js', () => ({ db: jest.fn<any>() }))
jest.unstable_mockModule('../db/index.js', () => ({ pool: {} }))
jest.unstable_mockModule('../services/user.service.js', () => ({ userService: {}, DeleteResult: {} }))
jest.unstable_mockModule('../services/session.js', () => ({
  recordSession: jest.fn<any>(), validateSession: jest.fn<any>(),
  forceRevokeUserSessions: jest.fn<any>(), revokeAllUserSessions: jest.fn<any>(),
}))
jest.unstable_mockModule('../services/vaultStore.js', () => ({ cancelVaultById: jest.fn<any>() }))
jest.unstable_mockModule('../services/dbMetrics.js', () => ({ getDBHealthMetrics: jest.fn<any>(), getSlowQueryBuffer: jest.fn<any>(() => []) }))
jest.unstable_mockModule('../services/featureFlags.js', () => ({
  getFlag: jest.fn<any>(), setFlag: jest.fn<any>(),
  isValidFeatureFlag: jest.fn<any>(), getAllFlags: jest.fn<any>(),
}))
jest.unstable_mockModule('../security/abuse-monitor.js', () => ({ getAbuseCategoryCounts: jest.fn<any>(() => ({})) }))
jest.unstable_mockModule('../services/checkpointStore.js', () => ({ CheckpointStore: class {} }))
jest.unstable_mockModule('../services/monitor.js', () => ({ getLatestListenerLag: jest.fn<any>() }))
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({ metricsRateLimiter: (_r: any, _s: any, n: any) => n() }))
jest.unstable_mockModule('../middleware/queryParser.js', () => ({ queryParser: () => (_r: any, _s: any, n: any) => n() }))
jest.unstable_mockModule('../lib/auth-utils.js', () => ({
  generateAccessToken: jest.fn<any>((payload: any) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.sig`
  }),
  verifyAccessToken: jest.fn<any>((token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())),
  generateImpersonationToken: jest.fn<any>(() => 'impersonation-token'),
}))
jest.unstable_mockModule('../lib/prismaScope.js', () => ({ getPrisma: jest.fn<any>(() => ({})) }))
jest.unstable_mockModule('../middleware/stepUp.js', () => ({ requireStepUp: jest.fn<any>(() => (_r: any, _s: any, n: any) => n()) }))

const { adminRouter } = await import('../routes/admin.js')
const { generateAccessToken } = await import('../lib/auth-utils.js')

const testApp = express()
testApp.use(express.json())
testApp.use('/api/admin', adminRouter)

// ── Token helpers ─────────────────────────────────────────────────────────────

const adminToken = () => generateAccessToken({ userId: 'admin-user-id', role: UserRole.ADMIN })
const userToken = () => generateAccessToken({ userId: 'user-id', role: UserRole.USER })

const SAMPLE_PROGRESS = [
  { jobName: 'milestone-evidence-embedding-reindex', cursor: 'm-100', processed: 100, paused: false, etaMs: 5000, updatedAt: '2026-01-01T00:00:00.000Z' },
]

// ── GET /api/admin/backfills ──────────────────────────────────────────────────

describe('GET /api/admin/backfills', () => {
  beforeEach(() => {
    listProgressFn.mockReset()
    listProgressFn.mockResolvedValue(SAMPLE_PROGRESS)
    createAuditLogFn.mockReset()
    createAuditLogFn.mockResolvedValue({ id: 'audit-123' })
  })

  it('returns 200 with progress list for admin', async () => {
    const res = await request(testApp).get('/api/admin/backfills').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(SAMPLE_PROGRESS)
  })

  it('returns 403 for non-admin', async () => {
    await request(testApp).get('/api/admin/backfills').set('Authorization', `Bearer ${userToken()}`).expect(403)
  })

  it('returns 401 when unauthenticated', async () => {
    await request(testApp).get('/api/admin/backfills').expect(401)
  })

  it('returns 500 when store throws', async () => {
    listProgressFn.mockRejectedValue(new Error('db error'))
    const res = await request(testApp).get('/api/admin/backfills').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(500)
  })
})

// ── POST /api/admin/backfills/:name/pause ────────────────────────────────────

describe('POST /api/admin/backfills/:name/pause', () => {
  beforeEach(() => {
    pauseFn.mockReset()
    pauseFn.mockResolvedValue(undefined)
    createAuditLogFn.mockReset()
    createAuditLogFn.mockResolvedValue({ id: 'audit-123' })
  })

  it('pauses the named backfill and returns paused:true', async () => {
    const res = await request(testApp).post('/api/admin/backfills/my-job/pause').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ paused: true, jobName: 'my-job' })
    expect(pauseFn).toHaveBeenCalledWith('my-job')
  })

  it('writes an audit log on pause', async () => {
    await request(testApp).post('/api/admin/backfills/my-job/pause').set('Authorization', `Bearer ${adminToken()}`)
    expect(createAuditLogFn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'backfill.pause', target_type: 'backfill', target_id: 'my-job', actor_user_id: 'admin-user-id' }),
    )
  })

  it('returns 403 for non-admin', async () => {
    await request(testApp).post('/api/admin/backfills/my-job/pause').set('Authorization', `Bearer ${userToken()}`).expect(403)
  })

  it('returns 500 when store throws', async () => {
    pauseFn.mockRejectedValue(new Error('db error'))
    const res = await request(testApp).post('/api/admin/backfills/my-job/pause').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(500)
  })
})

// ── POST /api/admin/backfills/:name/resume ───────────────────────────────────

describe('POST /api/admin/backfills/:name/resume', () => {
  beforeEach(() => {
    resumeFn.mockReset()
    resumeFn.mockResolvedValue(undefined)
    createAuditLogFn.mockReset()
    createAuditLogFn.mockResolvedValue({ id: 'audit-123' })
  })

  it('resumes the named backfill and returns paused:false', async () => {
    const res = await request(testApp).post('/api/admin/backfills/my-job/resume').set('Authorization', `Bearer ${adminToken()}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ paused: false, jobName: 'my-job' })
    expect(resumeFn).toHaveBeenCalledWith('my-job')
  })

  it('writes an audit log on resume', async () => {
    await request(testApp).post('/api/admin/backfills/my-job/resume').set('Authorization', `Bearer ${adminToken()}`)
    expect(createAuditLogFn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'backfill.resume', target_type: 'backfill', target_id: 'my-job', actor_user_id: 'admin-user-id' }),
    )
  })

  it('returns 403 for non-admin', async () => {
    await request(testApp).post('/api/admin/backfills/my-job/resume').set('Authorization', `Bearer ${userToken()}`).expect(403)
  })
})

// ── BackfillCursorStore logic (in-memory) ─────────────────────────────────────

class InMemoryBackfillStore {
  private rows = new Map<string, any>()
  async getCursor(n: string) { return this.rows.get(n)?.cursor ?? null }
  async upsertCursor(n: string, c: string | null) { this.rows.set(n, { ...(this.rows.get(n) ?? {}), cursor: c }) }
  async isPaused(n: string) { return Boolean(this.rows.get(n)?.paused) }
  async pause(n: string) { this.rows.set(n, { ...(this.rows.get(n) ?? {}), paused: true }) }
  async resume(n: string) { this.rows.set(n, { ...(this.rows.get(n) ?? {}), paused: false }) }
  async recordProgress(n: string, count: number) {
    const row = this.rows.get(n) ?? {}
    this.rows.set(n, { ...row, processed: (row.processed ?? 0) + count })
  }
  async listProgress() {
    return Array.from(this.rows.entries()).map(([jobName, row]) => ({
      jobName, cursor: row.cursor ?? null, processed: row.processed ?? 0,
      paused: Boolean(row.paused), etaMs: null, updatedAt: new Date().toISOString(),
    }))
  }
}

describe('BackfillCursorStore logic', () => {
  let store: InMemoryBackfillStore
  beforeEach(() => { store = new InMemoryBackfillStore() })

  it('isPaused returns false for unknown job', async () => {
    expect(await store.isPaused('job')).toBe(false)
  })
  it('pause sets paused=true; resume clears it', async () => {
    await store.pause('job')
    expect(await store.isPaused('job')).toBe(true)
    await store.resume('job')
    expect(await store.isPaused('job')).toBe(false)
  })
  it('recordProgress accumulates count', async () => {
    await store.recordProgress('job', 50)
    await store.recordProgress('job', 25)
    const [snap] = await store.listProgress()
    expect(snap.processed).toBe(75)
  })
  it('listProgress empty when no jobs', async () => {
    expect(await store.listProgress()).toEqual([])
  })
  it('listProgress includes paused flag and jobName', async () => {
    await store.pause('job-a')
    const [snap] = await store.listProgress()
    expect(snap.paused).toBe(true)
    expect(snap.jobName).toBe('job-a')
  })
})

// ── evidenceReindex pause integration ────────────────────────────────────────

class FakeSource implements MilestoneEmbeddingSource {
  upsertCalls: string[] = []
  constructor(private rows: Array<{ id: string; title: string; description: string | null }>) {}
  async listMilestonesAfter(afterId: string | null, limit: number) {
    const sorted = [...this.rows].sort((a, b) => a.id.localeCompare(b.id))
    return (afterId === null ? sorted : sorted.filter(m => m.id > afterId)).slice(0, limit)
  }
  async findEmbeddingModelVersions(_ids: string[]) { return new Map<string, string>() }
  async upsertEmbedding(id: string) { this.upsertCalls.push(id) }
}

class FakeCursorStore implements ReindexCursorStore {
  private cursors = new Map<string, string | null>()
  private _paused = false
  async getCursor(n: string) { return this.cursors.get(n) ?? null }
  async upsertCursor(n: string, c: string | null) { this.cursors.set(n, c) }
  async isPaused(_n: string) { return this._paused }
  async recordProgress(_n: string, _c: number) {}
  setPaused(v: boolean) { this._paused = v }
}

const provider = new DeterministicEmbeddingProvider('v1')

describe('reindexEvidenceBatch — pause behavior', () => {
  it('returns paused:true without processing when paused', async () => {
    const store = new FakeCursorStore()
    store.setPaused(true)
    const result = await reindexEvidenceBatch({ source: new FakeSource([{ id: 'm-001', title: 'T', description: null }]), cursorStore: store, embeddingProvider: provider })
    expect(result.paused).toBe(true)
    expect(result.processed).toBe(0)
  })
  it('processes normally when not paused', async () => {
    const result = await reindexEvidenceBatch({ source: new FakeSource([{ id: 'm-001', title: 'T', description: null }]), cursorStore: new FakeCursorStore(), embeddingProvider: provider })
    expect(result.processed).toBe(1)
    expect(result.paused).toBeUndefined()
  })
})

describe('runReindexBatches — stops when paused', () => {
  it('stops after one paused batch', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `m-00${i}`, title: `T${i}`, description: null as string | null }))
    const store = new FakeCursorStore()
    store.setPaused(true)
    const result = await runReindexBatches({ source: new FakeSource(rows), cursorStore: store, embeddingProvider: provider, batchSize: 2, maxBatchesPerRun: 5 })
    expect(result.paused).toBe(true)
    expect(result.batches).toBe(1)
    expect(result.processed).toBe(0)
  })
})

describe('reindexEvidenceBatch — resume without gaps or duplicates', () => {
  it('resumes from cursor without reprocessing earlier items', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `m-00${i}`, title: `T${i}`, description: null as string | null }))
    const source = new FakeSource(rows)
    const store = new FakeCursorStore()
    await reindexEvidenceBatch({ source, cursorStore: store, embeddingProvider: provider, batchSize: 2 })
    expect(source.upsertCalls).toEqual(['m-000', 'm-001'])
    await reindexEvidenceBatch({ source, cursorStore: store, embeddingProvider: provider, batchSize: 2 })
    expect(source.upsertCalls).toEqual(['m-000', 'm-001', 'm-002', 'm-003'])
  })
})

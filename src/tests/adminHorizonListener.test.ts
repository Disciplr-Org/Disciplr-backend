import express from 'express'
import request from 'supertest'
import { jest, describe, it, expect, beforeEach } from '@jest/globals'

const checkpointRows = [
  {
    id: 1,
    contractAddress: 'CCONTRACT1',
    lastLedger: 125,
    lastPagingToken: '125-0',
    updatedAt: new Date('2026-06-26T10:00:00.000Z'),
    createdAt: new Date('2026-06-25T10:00:00.000Z'),
  },
]

let mutableCheckpoints = [...checkpointRows]
const confirmationTokens = new Map<string, Record<string, unknown>>()
let listenerState = {
  last_processed_ledger: 120,
  last_processed_at: new Date(Date.now() - 10_000).toISOString(),
  updated_at: new Date('2026-06-26T10:00:05.000Z').toISOString(),
}
let failedEvent = {
  event_id: 'evt-1',
  error_message: 'parse failed',
  failed_at: new Date('2026-06-26T10:01:00.000Z').toISOString(),
  retry_count: 2,
}
let maxProcessedLedger: string | number | null = 130

const getAllCheckpoints = jest.fn(async () => mutableCheckpoints)
const getCheckpoint = jest.fn(async (contractAddress: string) =>
  mutableCheckpoints.find((checkpoint) => checkpoint.contractAddress === contractAddress) ?? null,
)
const resetCheckpoint = jest.fn(async (contractAddress: string, ledger: number, pagingToken: string | null) => {
  const existing = mutableCheckpoints.find((checkpoint) => checkpoint.contractAddress === contractAddress)
  const updated = {
    id: existing?.id ?? 2,
    contractAddress,
    lastLedger: ledger,
    lastPagingToken: pagingToken,
    updatedAt: new Date('2026-06-26T11:00:00.000Z'),
    createdAt: existing?.createdAt ?? new Date('2026-06-26T11:00:00.000Z'),
  }
  mutableCheckpoints = [
    ...mutableCheckpoints.filter((checkpoint) => checkpoint.contractAddress !== contractAddress),
    updated,
  ]
})

const createAuditLog = jest.fn(async () => ({
  id: 'audit-horizon-reset',
  created_at: '2026-06-26T11:00:00.000Z',
}))

type AuthRequest = {
  headers: { authorization?: string }
  user?: { userId: string; role: 'ADMIN' | 'USER' }
}
type AuthResponse = { status: (code: number) => { json: (body: { error: string }) => void } }

const authMiddleware = jest.fn((req: AuthRequest, res: AuthResponse, next: () => void) => {
  const authorization = req.headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header' })
    return
  }

  const token = authorization.slice(7)
  if (token === 'admin') {
    req.user = { userId: 'admin-1', role: 'ADMIN' }
    next()
    return
  }
  if (token === 'user') {
    req.user = { userId: 'user-1', role: 'USER' }
    next()
    return
  }

  res.status(401).json({ error: 'Unauthorized: Invalid token' })
})

const makeDbChain = (tableName: string) => {
  if (tableName === 'listener_state') {
    return {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      first: jest.fn(async () => listenerState),
    }
  }

  if (tableName === 'failed_events') {
    return {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn(async () => failedEvent),
    }
  }

  if (tableName === 'processed_events') {
    return {
      max: jest.fn().mockReturnThis(),
      first: jest.fn(async () => ({ max_ledger: maxProcessedLedger })),
    }
  }

  return {
    count: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn(async () => undefined),
  }
}

const db = jest.fn((tableName: string) => {
  if (tableName === 'confirmation_tokens') {
    return {
      insert: jest.fn(async (row: Record<string, unknown>) => {
        confirmationTokens.set(String(row.token_id), { ...row })
        return [1]
      }),
      where: jest.fn((conditions: Record<string, unknown>) => ({
        first: jest.fn(async () => {
          const token = confirmationTokens.get(String(conditions.token_id))
          return token ? { ...token } : null
        }),
        update: jest.fn(async (changes: Record<string, unknown>) => {
          const existing = confirmationTokens.get(String(conditions.token_id))
          if (!existing) return 0
          confirmationTokens.set(String(conditions.token_id), { ...existing, ...changes })
          return 1
        }),
      })),
      delete: jest.fn(async () => {
        confirmationTokens.clear()
        return 0
      }),
    }
  }
  return makeDbChain(tableName)
})

// ESM mocks must be registered before the dynamic import of the router.
// The real confirmation-token middleware runs against an in-memory token table,
// so cursor resets still require a valid, single-use action-scoped token.
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticate: authMiddleware }))
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({ metricsRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next() }))
jest.unstable_mockModule('../middleware/queryParser.js', () => ({ queryParser: () => (_req: unknown, _res: unknown, next: () => void) => next() }))
jest.unstable_mockModule('../middleware/stepUp.js', () => ({ requireStepUp: () => (_req: unknown, _res: unknown, next: () => void) => next() }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog,
  getAuditLogById: jest.fn(),
  listAuditLogs: jest.fn(),
  exportAuditLogsForOrganization: jest.fn(),
  verifyAuditLogChain: jest.fn(),
}))
jest.unstable_mockModule('../services/checkpointStore.js', () => ({
  CheckpointStore: class {
    getAllCheckpoints = getAllCheckpoints
    getCheckpoint = getCheckpoint
    resetCheckpoint = resetCheckpoint
  },
}))
jest.unstable_mockModule('../services/monitor.js', () => ({ getLatestListenerLag: () => 7 }))
jest.unstable_mockModule('../db/knex.js', () => ({ db }))
jest.unstable_mockModule('../db/index.js', () => ({ db, default: db, pool: {} }))
jest.unstable_mockModule('../services/user.service.js', () => ({ userService: {}, DeleteResult: {} }))
jest.unstable_mockModule('../services/session.js', () => ({
  forceRevokeUserSessions: jest.fn(),
  recordSession: jest.fn(),
}))
jest.unstable_mockModule('../services/vaultStore.js', () => ({ cancelVaultById: jest.fn() }))
jest.unstable_mockModule('../services/dbMetrics.js', () => ({
  getDBHealthMetrics: jest.fn(),
  getSlowQueryBuffer: jest.fn(),
}))
jest.unstable_mockModule('../services/featureFlags.js', () => ({
  getFlag: jest.fn(),
  setFlag: jest.fn(),
  isValidFeatureFlag: jest.fn(),
  getAllFlags: jest.fn(),
}))
jest.unstable_mockModule('../security/abuse-monitor.js', () => ({ getAbuseCategoryCounts: jest.fn(() => ({})) }))
jest.unstable_mockModule('../lib/auth-utils.js', () => ({ generateImpersonationToken: jest.fn() }))
jest.unstable_mockModule('../lib/prismaScope.js', () => ({ getPrisma: jest.fn() }))
jest.unstable_mockModule('../services/embeddingProvider.js', () => ({
  detectEmbeddingDrift: jest.fn(),
  CURRENT_EMBEDDING_MODEL_VERSION: 'test',
  createEmbeddingProvider: jest.fn(),
}))
jest.unstable_mockModule('../services/evidenceReindex.js', () => ({
  runReindexBatches: jest.fn(),
  EMBEDDING_REINDEX_JOB_NAME: 'test-reindex',
}))
jest.unstable_mockModule('../repositories/milestoneRepository.js', () => ({ MilestoneRepository: class {} }))
jest.unstable_mockModule('../services/backfillCursorStore.js', () => ({ BackfillCursorStore: class {} }))
jest.unstable_mockModule('../services/transactionETL.js', () => ({ TransactionETLService: class {} }))
jest.unstable_mockModule('../services/etlWorker.js', () => ({ resolveETLConfig: jest.fn() }))
jest.unstable_mockModule('../services/idempotency.js', () => ({ resetIdempotencyStore: jest.fn() }))

const { adminRouter } = await import('../routes/admin.js')

const app = express()
app.use(express.json())
app.use('/api/admin', adminRouter)

async function prepareResetToken(): Promise<string> {
  const response = await request(app)
    .post('/api/admin/confirm/prepare')
    .set('Authorization', 'Bearer admin')
    .send({ action: 'horizon.cursor.reset', scope: 'CCONTRACT1' })
    .expect(201)

  expect(response.body).toMatchObject({
    action: 'horizon.cursor.reset',
    scope: 'CCONTRACT1',
    dualControlRequired: false,
  })
  return response.body.tokenId as string
}

describe('admin Horizon listener routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mutableCheckpoints = [...checkpointRows]
    confirmationTokens.clear()
    listenerState = {
      last_processed_ledger: 120,
      last_processed_at: new Date(Date.now() - 10_000).toISOString(),
      updated_at: new Date('2026-06-26T10:00:05.000Z').toISOString(),
    }
    failedEvent = {
      event_id: 'evt-1',
      error_message: 'parse failed',
      failed_at: new Date('2026-06-26T10:01:00.000Z').toISOString(),
      retry_count: 2,
    }
    maxProcessedLedger = 130
    delete process.env.CONTRACT_ADDRESS
  })

  it('returns detailed listener status for admins', async () => {
    const response = await request(app)
      .get('/api/admin/horizon/listener')
      .set('Authorization', 'Bearer admin')

    expect(response.status).toBe(200)
    expect(response.body.data.cursor.effectiveLedger).toBe(125)
    expect(response.body.data.cursor.checkpoints[0]).toMatchObject({
      contractAddress: 'CCONTRACT1',
      lastLedger: 125,
      lastPagingToken: '125-0',
    })
    expect(response.body.data.lastProcessedLedger).toBe(120)
    expect(response.body.data.latestProcessedLedger).toBe(130)
    expect(response.body.data.lag).toBe(7)
    expect(response.body.data.heartbeatAgeMs).toEqual(expect.any(Number))
    expect(response.body.data.lastError).toMatchObject({
      eventId: 'evt-1',
      message: 'parse failed',
      retryCount: 2,
    })
  })

  it('resets the cursor and writes an audit log', async () => {
    const tokenId = await prepareResetToken()
    const response = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
      .set('X-Confirmation-Token', tokenId)
      .send({
        contractAddress: 'CCONTRACT1',
        ledger: 135,
        pagingToken: '135-0',
        reason: 'manual recovery after checkpoint stall',
      })

    expect(response.status).toBe(200)
    expect(resetCheckpoint).toHaveBeenCalledWith('CCONTRACT1', 135, '135-0')
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actor_user_id: 'admin-1',
      action: 'horizon.listener.cursor_reset',
      target_type: 'horizon_listener',
      target_id: 'CCONTRACT1',
    }))
    expect(response.body).toMatchObject({
      message: 'Horizon listener cursor reset',
      auditLogId: 'audit-horizon-reset',
      forced: false,
      latestProcessedLedger: 130,
    })
    expect(response.body.checkpoint).toMatchObject({
      contractAddress: 'CCONTRACT1',
      lastLedger: 135,
      lastPagingToken: '135-0',
    })
  })

  it('refuses to move behind processed events unless forced', async () => {
    const tokenId = await prepareResetToken()
    createAuditLog.mockClear()
    const response = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
      .set('X-Confirmation-Token', tokenId)
      .send({
        contractAddress: 'CCONTRACT1',
        ledger: 100,
        pagingToken: '100-0',
      })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      latestProcessedLedger: 130,
      requestedLedger: 100,
    })
    expect(resetCheckpoint).not.toHaveBeenCalled()
    expect(createAuditLog).not.toHaveBeenCalled()
  })

  it('allows forced backward cursor resets', async () => {
    const tokenId = await prepareResetToken()
    const response = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
      .set('X-Confirmation-Token', tokenId)
      .send({
        contractAddress: 'CCONTRACT1',
        ledger: 100,
        pagingToken: '100-0',
        force: true,
      })

    expect(response.status).toBe(200)
    expect(resetCheckpoint).toHaveBeenCalledWith('CCONTRACT1', 100, '100-0')
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ force: true }),
    }))
  })

  it('rejects cursor resets without an action-scoped confirmation token', async () => {
    const noToken = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
      .send({ contractAddress: 'CCONTRACT1', ledger: 135 })

    expect(noToken.status).toBe(403)
    expect(noToken.body).toMatchObject({
      confirmationRequired: true,
      action: 'horizon.cursor.reset',
    })
    expect(resetCheckpoint).not.toHaveBeenCalled()
    expect(createAuditLog).not.toHaveBeenCalled()

    const badToken = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
      .set('X-Confirmation-Token', 'not-a-confirmation-token')
      .send({ contractAddress: 'CCONTRACT1', ledger: 135 })

    expect(badToken.status).toBe(403)
    expect(resetCheckpoint).not.toHaveBeenCalled()
  })

  it('consumes a valid confirmation token only once', async () => {
    const tokenId = await prepareResetToken()
    const reset = () => request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
      .set('X-Confirmation-Token', tokenId)
      .send({ contractAddress: 'CCONTRACT1', ledger: 135 })

    expect((await reset()).status).toBe(200)
    expect((await reset()).status).toBe(403)
    expect(resetCheckpoint).toHaveBeenCalledTimes(1)
  })

  it('keeps 401-before-403 for protected listener routes', async () => {
    const unauthenticated = await request(app).get('/api/admin/horizon/listener')
    expect(unauthenticated.status).toBe(401)

    const forbidden = await request(app)
      .get('/api/admin/horizon/listener')
      .set('Authorization', 'Bearer user')
    expect(forbidden.status).toBe(403)
  })
})

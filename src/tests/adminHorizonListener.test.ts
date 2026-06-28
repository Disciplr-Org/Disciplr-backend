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
let listenerState: any = {
  last_processed_ledger: 120,
  last_processed_at: new Date(Date.now() - 10_000).toISOString(),
  updated_at: new Date('2026-06-26T10:00:05.000Z').toISOString(),
}
let failedEvent: any = {
  event_id: 'evt-1',
  error_message: 'parse failed',
  failed_at: new Date('2026-06-26T10:01:00.000Z').toISOString(),
  retry_count: 2,
}
let maxProcessedLedger: string | number | null = 130

const getAllCheckpoints = jest.fn<any>(async () => mutableCheckpoints)
const getCheckpoint = jest.fn<any>(async (contractAddress: string) =>
  mutableCheckpoints.find((checkpoint) => checkpoint.contractAddress === contractAddress) ?? null,
)
const resetCheckpoint = jest.fn<any>(async (contractAddress: string, ledger: number, pagingToken: string | null) => {
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

const createAuditLog = jest.fn<any>(async () => ({
  id: 'audit-horizon-reset',
  created_at: '2026-06-26T11:00:00.000Z',
}))

const authMiddleware = jest.fn<any>((req: any, res: any, next: any) => {
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
      where: jest.fn<any>().mockReturnThis(),
      select: jest.fn<any>().mockReturnThis(),
      first: jest.fn<any>(async () => listenerState),
    }
  }

  if (tableName === 'failed_events') {
    return {
      select: jest.fn<any>().mockReturnThis(),
      orderBy: jest.fn<any>().mockReturnThis(),
      first: jest.fn<any>(async () => failedEvent),
    }
  }

  if (tableName === 'processed_events') {
    return {
      max: jest.fn<any>().mockReturnThis(),
      first: jest.fn<any>(async () => ({ max_ledger: maxProcessedLedger })),
    }
  }

  return {
    count: jest.fn<any>().mockReturnThis(),
    where: jest.fn<any>().mockReturnThis(),
    first: jest.fn<any>(async () => undefined),
  }
}

const db = jest.fn<any>((tableName: string) => makeDbChain(tableName))

jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticate: authMiddleware }))
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({ metricsRateLimiter: (_req: any, _res: any, next: any) => next() }))
jest.unstable_mockModule('../middleware/queryParser.js', () => ({ queryParser: () => (_req: any, _res: any, next: any) => next() }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog,
  getAuditLogById: jest.fn<any>(),
  listAuditLogs: jest.fn<any>(),
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
jest.unstable_mockModule('../db/index.js', () => ({ pool: {} }))
jest.unstable_mockModule('../services/user.service.js', () => ({ userService: {}, DeleteResult: {} }))
jest.unstable_mockModule('../services/session.js', () => ({ forceRevokeUserSessions: jest.fn<any>() }))
jest.unstable_mockModule('../services/vaultStore.js', () => ({ cancelVaultById: jest.fn<any>() }))
jest.unstable_mockModule('../services/dbMetrics.js', () => ({ getDBHealthMetrics: jest.fn<any>() }))
jest.unstable_mockModule('../services/featureFlags.js', () => ({
  getFlag: jest.fn<any>(),
  setFlag: jest.fn<any>(),
  isValidFeatureFlag: jest.fn<any>(),
  getAllFlags: jest.fn<any>(),
}))
jest.unstable_mockModule('../security/abuse-monitor.js', () => ({ getAbuseCategoryCounts: jest.fn<any>(() => ({})) }))

const { adminRouter } = await import('../routes/admin.js')

const app = express()
app.use(express.json())
app.use('/api/admin', adminRouter)

describe('admin Horizon listener routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mutableCheckpoints = [...checkpointRows]
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
    const response = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
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
    const response = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
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
    const response = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', 'Bearer admin')
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

  it('keeps 401-before-403 for protected listener routes', async () => {
    const unauthenticated = await request(app).get('/api/admin/horizon/listener')
    expect(unauthenticated.status).toBe(401)

    const forbidden = await request(app)
      .get('/api/admin/horizon/listener')
      .set('Authorization', 'Bearer user')
    expect(forbidden.status).toBe(403)
  })
})

import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const mockRecordVerification = mock(async () => MOCK_REC)
const mockCreateAuditLog = mock(async () => MOCK_AUDIT)
const mockCreateEvidenceReference = mock(async () => MOCK_EVIDENCE)
const mockListVerifications = mock(async () => [])
const mockTrx = { isMockTrx: true }
const mockDbTransaction = mock(async (cb: (trx: any) => Promise<any>) => cb(mockTrx))

mock.module('../db/knex.js', () => ({
  db: { transaction: mockDbTransaction },
  closeDatabase: mock(() => {}),
}))

mock.module('../utils/retry.js', () => ({
  retryWithBackoff: mock(async (op: () => Promise<any>) => op()),
  isRetryable: mock(() => false),
  DEFAULT_RETRY_CONFIG: {},
  sleep: mock(async () => {}),
  calculateJitter: mock(() => 0),
}))

mock.module('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'verifier-1', role: 'VERIFIER' } as any
    next()
  },
}))

mock.module('../middleware/rbac.js', () => ({
  requireVerifier: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

mock.module('../services/verifiers.js', () => ({
  recordVerification: mockRecordVerification,
  listVerifications: mockListVerifications,
}))

mock.module('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

mock.module('../services/evidence.js', () => ({
  createEvidenceReference: mockCreateEvidenceReference,
  EvidenceReferenceValidationError: class EvidenceReferenceValidationError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'EvidenceReferenceValidationError'
    }
  },
}))

const { verificationsRouter } = await import('../routes/verifications.js')
const { resetIdempotencyStore } = await import('../services/idempotency.js')

const HASH = 'a'.repeat(64)
const REF_URL = 'https://s3.example.com/evidence.pdf?Expires=32503680000&signature=abc'

const VALID_BODY = {
  targetId: 'milestone-1',
  result: 'approved',
  evidenceHash: HASH,
  evidenceReferenceUrl: REF_URL,
}

const MOCK_REC = {
  id: 'ver-1',
  verifierUserId: 'verifier-1',
  targetId: 'milestone-1',
  result: 'approved',
  evidenceHash: HASH,
  disputed: false,
  timestamp: '2026-06-27T04:00:00.000Z',
}

const MOCK_REC_2 = {
  ...MOCK_REC,
  id: 'ver-2',
  timestamp: '2026-06-27T04:01:00.000Z',
}

const MOCK_AUDIT = {
  id: 'audit-1',
  actor_user_id: 'verifier-1',
  action: 'verification.decision.recorded',
  target_type: 'verification',
  target_id: 'milestone-1',
  metadata: {},
  created_at: '2026-06-27T04:00:00.000Z',
}

const MOCK_EVIDENCE = {
  id: 'ev-1',
  verificationId: 'ver-1',
  evidenceHash: HASH,
  referenceUrl: REF_URL,
  expiresAt: '2030-01-01T00:00:00.000Z',
  createdAt: '2026-06-27T04:00:00.000Z',
}

const makeApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/verifications', verificationsRouter)
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message })
  })
  return app
}

const app = makeApp()

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setupHappyPath(record = MOCK_REC) {
  mockRecordVerification.mockImplementation(async () => record)
  mockCreateAuditLog.mockImplementation(async () => MOCK_AUDIT)
  mockCreateEvidenceReference.mockImplementation(async () => MOCK_EVIDENCE)
  mockDbTransaction.mockImplementation(async (cb: (trx: any) => Promise<any>) => cb(mockTrx))
}

describe('verifications idempotency-key support', () => {
  beforeEach(() => {
    resetIdempotencyStore()
    delete process.env.IDEMPOTENCY_TTL_MS
    mockRecordVerification.mockClear()
    mockCreateAuditLog.mockClear()
    mockCreateEvidenceReference.mockClear()
    mockDbTransaction.mockClear()
    setupHappyPath()
  })

  afterEach(() => {
    delete process.env.IDEMPOTENCY_TTL_MS
    resetIdempotencyStore()
  })

  test('replays an identical request without recording another verification', async () => {
    const first = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'checkin-same-key')
      .send(VALID_BODY)

    const replay = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'checkin-same-key')
      .send({ ...VALID_BODY })

    expect(first.status).toBe(201)
    expect(first.body.idempotency).toEqual({ key: 'checkin-same-key', replayed: false })
    expect(replay.status).toBe(200)
    expect(replay.body.verification.id).toBe('ver-1')
    expect(replay.body.idempotency).toEqual({ key: 'checkin-same-key', replayed: true })
    expect(mockRecordVerification).toHaveBeenCalledTimes(1)
    expect(mockCreateEvidenceReference).toHaveBeenCalledTimes(1)
  })

  test('rejects the same key with a conflicting body before side effects', async () => {
    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'checkin-conflict-key')
      .send(VALID_BODY)
      .expect(201)

    const conflict = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'checkin-conflict-key')
      .send({ ...VALID_BODY, result: 'rejected' })

    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toMatch(/different payload/i)
    expect(mockRecordVerification).toHaveBeenCalledTimes(1)
  })

  test('evicts expired keys so a later retry can execute again', async () => {
    process.env.IDEMPOTENCY_TTL_MS = '1'

    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'checkin-ttl-key')
      .send(VALID_BODY)
      .expect(201)

    await pause(10)
    setupHappyPath(MOCK_REC_2)

    const afterTtl = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'checkin-ttl-key')
      .send(VALID_BODY)

    expect(afterTtl.status).toBe(201)
    expect(afterTtl.body.verification.id).toBe('ver-2')
    expect(afterTtl.body.idempotency).toEqual({ key: 'checkin-ttl-key', replayed: false })
    expect(mockRecordVerification).toHaveBeenCalledTimes(2)
  })

  test('deduplicates concurrent same-key submissions while the first is in flight', async () => {
    let resolveVerification: (value: typeof MOCK_REC) => void = () => {}
    const pendingVerification = new Promise<typeof MOCK_REC>((resolve) => {
      resolveVerification = resolve
    })
    mockRecordVerification.mockImplementationOnce(async () => pendingVerification)

    const first = request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'checkin-concurrent-key')
      .send(VALID_BODY)
    const second = request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'checkin-concurrent-key')
      .send(VALID_BODY)

    await pause(5)
    resolveVerification(MOCK_REC)

    const [firstRes, secondRes] = await Promise.all([first, second])

    expect(firstRes.status).toBe(201)
    expect(secondRes.status).toBe(200)
    expect(secondRes.body.idempotency).toEqual({ key: 'checkin-concurrent-key', replayed: true })
    expect(mockRecordVerification).toHaveBeenCalledTimes(1)
  })

  test('rejects invalid idempotency-key format', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'bad key!')
      .send(VALID_BODY)

    expect(res.status).toBe(400)
    expect(mockRecordVerification).not.toHaveBeenCalled()
  })
})

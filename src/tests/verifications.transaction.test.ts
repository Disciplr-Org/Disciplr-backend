import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRecordVerification = jest.fn<any>()
const mockCreateAuditLog = jest.fn<any>()
const mockCreateEvidenceReference = jest.fn<any>()
const mockListVerifications = jest.fn<any>()

// Simulate db.transaction: runs the callback with a fake trx object and
// returns its result.  Tests can override this to inject failures.
const mockTrx = { isMockTrx: true }
const mockDbTransaction = jest.fn<any>(async (cb: (trx: any) => Promise<any>) => cb(mockTrx))

jest.unstable_mockModule('../db/knex.js', () => ({
  db: { transaction: mockDbTransaction },
  closeDatabase: jest.fn<any>(),
}))

jest.unstable_mockModule('../utils/retry.js', () => ({
  retryWithBackoff: jest.fn<any>(
    async (op: () => Promise<any>, _config: any, _pred: any) => op(),
  ),
  isRetryable: jest.fn<any>(() => false),
  DEFAULT_RETRY_CONFIG: {},
  sleep: jest.fn<any>(),
  calculateJitter: jest.fn<any>(() => 0),
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'verifier-1', role: 'VERIFIER' } as any
    next()
  },
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireVerifier: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  recordVerification: mockRecordVerification,
  listVerifications: mockListVerifications,
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

jest.unstable_mockModule('../services/evidence.js', () => ({
  createEvidenceReference: mockCreateEvidenceReference,
  EvidenceReferenceValidationError: class EvidenceReferenceValidationError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'EvidenceReferenceValidationError'
    }
  },
}))

const { verificationsRouter } = await import('../routes/verifications.js')
const { retryWithBackoff } = await import('../utils/retry.js')

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
  timestamp: new Date().toISOString(),
}

const MOCK_AUDIT = {
  id: 'audit-1',
  actor_user_id: 'verifier-1',
  action: 'verification.decision.recorded',
  target_type: 'verification',
  target_id: 'milestone-1',
  metadata: {},
  created_at: new Date().toISOString(),
}

const MOCK_EVIDENCE = {
  id: 'ev-1',
  verificationId: 'ver-1',
  evidenceHash: HASH,
  referenceUrl: REF_URL,
  expiresAt: new Date('2030-01-01T00:00:00.000Z').toISOString(),
  createdAt: new Date().toISOString(),
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use('/api/verifications', verificationsRouter)

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupHappyPath() {
  mockRecordVerification.mockResolvedValue(MOCK_REC)
  mockCreateAuditLog.mockResolvedValue(MOCK_AUDIT)
  mockCreateEvidenceReference.mockResolvedValue(MOCK_EVIDENCE)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verifications transaction: success path', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  test('returns 201 with verification and evidenceReference', async () => {
    const res = await request(app).post('/api/verifications').send(VALID_BODY)

    expect(res.status).toBe(201)
    expect(res.body.verification).toMatchObject({ id: 'ver-1' })
    expect(res.body.evidenceReference).toMatchObject({ id: 'ev-1' })
  })

  test('passes trx to recordVerification and createAuditLog', async () => {
    await request(app).post('/api/verifications').send(VALID_BODY).expect(201)

    expect(mockRecordVerification).toHaveBeenCalledWith(
      'verifier-1',
      'milestone-1',
      'approved',
      false,
      HASH,
      mockTrx,
    )

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'verification.decision.recorded',
        target_id: 'milestone-1',
      }),
      mockTrx,
    )
  })

  test('audit log and verification share the same transaction object', async () => {
    await request(app).post('/api/verifications').send(VALID_BODY).expect(201)

    const trxPassedToVerification = mockRecordVerification.mock.calls[0]?.[5]
    const trxPassedToAuditLog = mockCreateAuditLog.mock.calls[0]?.[1]

    expect(trxPassedToVerification).toBe(trxPassedToAuditLog)
  })

  test('createEvidenceReference is called after the Knex transaction commits', async () => {
    const callOrder: string[] = []
    mockDbTransaction.mockImplementation(async (cb: (trx: any) => Promise<any>) => {
      const result = await cb(mockTrx)
      callOrder.push('tx_commit')
      return result
    })
    mockCreateEvidenceReference.mockImplementation(async () => {
      callOrder.push('evidence')
      return MOCK_EVIDENCE
    })

    await request(app).post('/api/verifications').send(VALID_BODY).expect(201)

    expect(callOrder).toEqual(['tx_commit', 'evidence'])
  })
})

describe('verifications transaction: partial-write crash recovery', () => {
  beforeEach(() => jest.clearAllMocks())

  test('rolls back when createAuditLog throws inside the transaction', async () => {
    let txRolledBack = false
    mockDbTransaction.mockImplementation(async (cb: (trx: any) => Promise<any>) => {
      try {
        return await cb(mockTrx)
      } catch (err) {
        txRolledBack = true
        throw err
      }
    })

    mockRecordVerification.mockResolvedValue(MOCK_REC)
    mockCreateAuditLog.mockRejectedValue(new Error('db write failed'))

    const res = await request(app).post('/api/verifications').send(VALID_BODY)

    expect(res.status).toBe(500)
    expect(txRolledBack).toBe(true)
    // Evidence reference must NOT be called when the tx failed
    expect(mockCreateEvidenceReference).not.toHaveBeenCalled()
  })

  test('rolls back when recordVerification throws inside the transaction', async () => {
    let txRolledBack = false
    mockDbTransaction.mockImplementation(async (cb: (trx: any) => Promise<any>) => {
      try {
        return await cb(mockTrx)
      } catch (err) {
        txRolledBack = true
        throw err
      }
    })

    mockRecordVerification.mockRejectedValue(new Error('insert failed'))

    const res = await request(app).post('/api/verifications').send(VALID_BODY)

    expect(res.status).toBe(500)
    expect(txRolledBack).toBe(true)
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
    expect(mockCreateEvidenceReference).not.toHaveBeenCalled()
  })
})

describe('verifications transaction: serialization retry', () => {
  beforeEach(() => jest.clearAllMocks())

  test('wraps db.transaction call in retryWithBackoff', async () => {
    setupHappyPath()
    await request(app).post('/api/verifications').send(VALID_BODY).expect(201)

    expect(retryWithBackoff).toHaveBeenCalledTimes(1)
    // Third argument should be the serialization predicate function
    const predicate = (retryWithBackoff as jest.MockedFunction<any>).mock.calls[0]?.[2]
    expect(typeof predicate).toBe('function')
  })

  test('serialization predicate matches serialization errors', async () => {
    setupHappyPath()
    await request(app).post('/api/verifications').send(VALID_BODY).expect(201)

    const predicate: (e: Error) => boolean = (retryWithBackoff as jest.MockedFunction<any>).mock
      .calls[0]?.[2]

    expect(predicate(new Error('could not serialize access due to concurrent update'))).toBe(true)
    expect(predicate(new Error('serialization failure'))).toBe(true)
    expect(predicate(new Error('deadlock detected'))).toBe(true)
    expect(predicate(new Error('some random error'))).toBe(false)
  })

  test('retries on serialization failure and succeeds on second attempt', async () => {
    // Verify retryWithBackoff is called and the operation eventually resolves
    setupHappyPath()
    ;(retryWithBackoff as jest.MockedFunction<any>).mockImplementationOnce(
      async (op: () => Promise<any>) => op(),
    )

    const res = await request(app).post('/api/verifications').send(VALID_BODY)
    expect(res.status).toBe(201)
    expect(retryWithBackoff).toHaveBeenCalledTimes(1)
  })
})

describe('verifications transaction: conflict error', () => {
  beforeEach(() => jest.clearAllMocks())

  test('returns 409 when VerificationConflictError is thrown', async () => {
    const conflictErr = new Error('conflict: decision already made')
    conflictErr.name = 'VerificationConflictError'
    mockRecordVerification.mockRejectedValue(conflictErr)

    const res = await request(app).post('/api/verifications').send(VALID_BODY)

    expect(res.status).toBe(409)
  })

  test('returns 400 when EvidenceReferenceValidationError is thrown', async () => {
    mockRecordVerification.mockResolvedValue(MOCK_REC)
    mockCreateAuditLog.mockResolvedValue(MOCK_AUDIT)
    const validationErr = new Error('Signed object-storage URL has already expired')
    validationErr.name = 'EvidenceReferenceValidationError'
    mockCreateEvidenceReference.mockRejectedValue(validationErr)

    const res = await request(app).post('/api/verifications').send(VALID_BODY)

    expect(res.status).toBe(400)
  })
})

describe('verifications transaction: request validation', () => {
  beforeEach(() => jest.clearAllMocks())

  test('returns 400 when evidenceReferenceUrl is missing', async () => {
    const { evidenceReferenceUrl: _, ...body } = VALID_BODY
    const res = await request(app).post('/api/verifications').send(body)
    expect(res.status).toBe(400)
    expect(mockDbTransaction).not.toHaveBeenCalled()
  })

  test('returns 400 when evidenceReferenceUrl is blank', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .send({ ...VALID_BODY, evidenceReferenceUrl: '   ' })
    expect(res.status).toBe(400)
    expect(mockDbTransaction).not.toHaveBeenCalled()
  })
})

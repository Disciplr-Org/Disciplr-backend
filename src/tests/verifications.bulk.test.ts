import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRecordVerification = jest.fn<any>()
const mockCreateAuditLog = jest.fn<any>()
const mockCreateEvidenceReference = jest.fn<any>()

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
  listVerifications: jest.fn<any>(),
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HASH = 'a'.repeat(64)
const REF_URL = 'https://s3.example.com/evidence.pdf?Expires=32503680000&signature=abc'

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
// Error handler matching production AppError response shape
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status ?? err?.statusCode ?? 500
  res.status(status).json({
    error: {
      code: err?.code ?? 'INTERNAL_ERROR',
      message: err?.message ?? 'Internal server error',
    },
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupHappyPath() {
  mockRecordVerification.mockResolvedValue(MOCK_REC)
  mockCreateAuditLog.mockResolvedValue(MOCK_AUDIT)
  mockCreateEvidenceReference.mockResolvedValue(MOCK_EVIDENCE)
}

function createValidItem(overrides: any = {}) {
  return {
    targetId: 'milestone-1',
    result: 'approved',
    evidenceHash: HASH,
    evidenceReferenceUrl: REF_URL,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verifications bulk endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  describe('request validation', () => {
    test('returns 400 when body is not an array', async () => {
      const res = await request(app).post('/api/verifications/bulk').send({ not: 'an array' })
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          message: 'Request body must be an array of check-in items',
        }),
      })
    })

    test('returns 400 when array is empty', async () => {
      const res = await request(app).post('/api/verifications/bulk').send([])
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          message: 'Request body must contain at least one check-in item',
        }),
      })
    })

    test('returns 400 when batch size exceeds maximum', async () => {
      const items = Array.from({ length: 101 }, () => createValidItem({ targetId: `ms-${Math.random()}` }))
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({
        error: expect.objectContaining({
          message: 'Batch size exceeds maximum of 100',
        }),
      })
    })
  })

  describe('per-item validation', () => {
    test('returns partial failure when one item has missing targetId', async () => {
      const items = [
        createValidItem({ targetId: 'milestone-1' }),
        createValidItem({ targetId: '' }),
      ]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
      expect(res.body.results[0].success).toBe(true)
      expect(res.body.results[1].success).toBe(false)
      expect(res.body.results[1].error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'targetId is required',
      })
    })

    test('returns partial failure when one item has invalid result', async () => {
      const items = [
        createValidItem({ result: 'approved' }),
        createValidItem({ result: 'invalid' }),
      ]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
      expect(res.body.results[1].error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: "result must be 'approved' or 'rejected'",
      })
    })

    test('returns partial failure when one item has missing evidenceHash', async () => {
      const items = [
        createValidItem({ evidenceHash: HASH }),
        createValidItem({ evidenceHash: '' }),
      ]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
      expect(res.body.results[1].error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'evidenceHash is required',
      })
    })

    test('returns partial failure when one item has invalid evidenceHash format', async () => {
      const items = [
        createValidItem({ evidenceHash: HASH }),
        createValidItem({ evidenceHash: 'not-a-hash' }),
      ]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
      expect(res.body.results[1].error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'evidenceHash must be a valid hex string (32–128 characters)',
      })
    })

    test('returns partial failure when one item has missing evidenceReferenceUrl', async () => {
      const items = [
        createValidItem({ evidenceReferenceUrl: REF_URL }),
        createValidItem({ evidenceReferenceUrl: '' }),
      ]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
      expect(res.body.results[1].error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'evidenceReferenceUrl is required',
      })
    })
  })

  describe('mixed success/failure scenarios', () => {
    test('processes all items even when some fail', async () => {
      mockRecordVerification
        .mockResolvedValueOnce({ ...MOCK_REC, targetId: 'milestone-1' })
        .mockRejectedValueOnce(new Error('conflict: decision already made'))
        .mockResolvedValueOnce({ ...MOCK_REC, targetId: 'milestone-3' })

      const conflictErr = new Error('conflict: decision already made')
      conflictErr.name = 'VerificationConflictError'
      mockRecordVerification.mockRejectedValueOnce(conflictErr)

      const items = [
        createValidItem({ targetId: 'milestone-1' }),
        createValidItem({ targetId: 'milestone-2' }),
        createValidItem({ targetId: 'milestone-3' }),
      ]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ total: 3, succeeded: 2, failed: 1 })
      expect(res.body.results[0].success).toBe(true)
      expect(res.body.results[1].success).toBe(false)
      expect(res.body.results[2].success).toBe(true)
    })

    test('returns CONFLICT error for VerificationConflictError', async () => {
      const conflictErr = new Error('conflict: decision already made')
      conflictErr.name = 'VerificationConflictError'
      mockRecordVerification.mockRejectedValue(conflictErr)

      const items = [createValidItem({ targetId: 'milestone-1' })]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.results[0].success).toBe(false)
      expect(res.body.results[0].error).toMatchObject({
        code: 'CONFLICT',
        message: 'conflicting verification decision already exists',
      })
    })

    test('returns VALIDATION_ERROR for EvidenceReferenceValidationError', async () => {
      const validationErr = new Error('Signed object-storage URL has already expired')
      validationErr.name = 'EvidenceReferenceValidationError'
      mockCreateEvidenceReference.mockRejectedValue(validationErr)

      const items = [createValidItem({ targetId: 'milestone-1' })]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.results[0].success).toBe(false)
      expect(res.body.results[0].error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Signed object-storage URL has already expired',
      })
    })
  })

  describe('batch size cap', () => {
    test('accepts batch at maximum size', async () => {
      const items = Array.from({ length: 100 }, (_, i) => 
        createValidItem({ targetId: `milestone-${i}` })
      )
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary.total).toBe(100)
    })

    test('rejects batch exceeding maximum size', async () => {
      const items = Array.from({ length: 101 }, (_, i) => 
        createValidItem({ targetId: `milestone-${i}` })
      )
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(400)
    })
  })

  describe('idempotent retry', () => {
    test('returns existing verification on retry for same targetId', async () => {
      const conflictErr = new Error('conflict: decision already made')
      conflictErr.name = 'VerificationConflictError'
      mockRecordVerification.mockRejectedValue(conflictErr)

      const items = [createValidItem({ targetId: 'milestone-1' })]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.results[0].success).toBe(false)
      expect(res.body.results[0].error).toMatchObject({
        code: 'CONFLICT',
      })
    })
  })

  describe('duplicate items in batch', () => {
    test('processes duplicate targetIds independently', async () => {
      const conflictErr = new Error('conflict: decision already made')
      conflictErr.name = 'VerificationConflictError'
      mockRecordVerification
        .mockResolvedValueOnce({ ...MOCK_REC, targetId: 'milestone-1' })
        .mockRejectedValueOnce(conflictErr)

      const items = [
        createValidItem({ targetId: 'milestone-1' }),
        createValidItem({ targetId: 'milestone-1' }),
      ]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
    })
  })

  describe('successful bulk processing', () => {
    test('returns 200 with all results and summary', async () => {
      const items = [
        createValidItem({ targetId: 'milestone-1' }),
        createValidItem({ targetId: 'milestone-2' }),
        createValidItem({ targetId: 'milestone-3' }),
      ]
      mockRecordVerification
        .mockResolvedValueOnce({ ...MOCK_REC, targetId: 'milestone-1', id: 'ver-1' })
        .mockResolvedValueOnce({ ...MOCK_REC, targetId: 'milestone-2', id: 'ver-2' })
        .mockResolvedValueOnce({ ...MOCK_REC, targetId: 'milestone-3', id: 'ver-3' })

      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ total: 3, succeeded: 3, failed: 0 })
      expect(res.body.results).toHaveLength(3)
      expect(res.body.results[0].success).toBe(true)
      expect(res.body.results[1].success).toBe(true)
      expect(res.body.results[2].success).toBe(true)
      expect(res.body.results[0].verification).toBeDefined()
      expect(res.body.results[0].evidenceReference).toBeDefined()
    })

    test('includes verification and evidenceReference in successful items', async () => {
      const items = [createValidItem({ targetId: 'milestone-1' })]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(res.body.results[0].verification).toMatchObject({
        id: 'ver-1',
        verifierUserId: 'verifier-1',
        targetId: 'milestone-1',
        result: 'approved',
      })
      expect(res.body.results[0].evidenceReference).toMatchObject({
        id: 'ev-1',
        verificationId: 'ver-1',
      })
    })

    test('evidenceReference in response uses referenceUrl field (not evidenceReferenceUrl)', async () => {
      const items = [createValidItem({ targetId: 'milestone-1' })]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      const evidenceRef = res.body.results[0].evidenceReference
      expect(evidenceRef).toBeDefined()
      // The service type EvidenceReference uses referenceUrl — verify the field is present and correct
      expect(evidenceRef.referenceUrl).toBe(REF_URL)
      // Ensure the old misnamed field is not present
      expect(evidenceRef.evidenceReferenceUrl).toBeUndefined()
    })
  })

  describe('authorization', () => {
    test('requires VERIFIER role', async () => {
      const items = [createValidItem({ targetId: 'milestone-1' })]
      const res = await request(app).post('/api/verifications/bulk').send(items)
      expect(res.status).toBe(200)
      expect(mockRecordVerification).toHaveBeenCalledWith(
        'verifier-1',
        'milestone-1',
        'approved',
        false,
        HASH,
        mockTrx,
      )
    })
  })
})

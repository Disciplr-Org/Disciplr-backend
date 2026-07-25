import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

const mockRecordVerification = jest.fn<any>()
const mockCreateAuditLog = jest.fn<any>()
const mockCreateEvidenceReference = jest.fn<any>()
const mockListVerifications = jest.fn<any>()
const mockGetIdempotentResponse = jest.fn<any>()
const mockSaveIdempotentResponse = jest.fn<any>()
const mockFailPendingIdempotentResponse = jest.fn<any>()
const mockHashRequestPayload = jest.fn<any>()
const mockValidateIdempotencyKey = jest.fn<any>()
const mockScopeIdempotencyKey = jest.fn<any>()

const mockTrx = { isMockTrx: true }
const mockDbTransaction = jest.fn<any>(async (cb: (trx: any) => Promise<any>) => cb(mockTrx))

jest.unstable_mockModule('../db/knex.js', () => ({
  db: { transaction: mockDbTransaction },
  closeDatabase: jest.fn<any>(),
}))

jest.unstable_mockModule('../utils/retry.js', () => ({
  retryWithBackoff: jest.fn<any>(
    async (op: () => Promise<any>) => op(),
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

jest.unstable_mockModule('../services/idempotency.js', () => ({
  getIdempotentResponse: mockGetIdempotentResponse,
  hashRequestPayload: mockHashRequestPayload,
  saveIdempotentResponse: mockSaveIdempotentResponse,
  failPendingIdempotentResponse: mockFailPendingIdempotentResponse,
  IdempotencyConflictError: class IdempotencyConflictError extends Error {
    constructor(message = 'Idempotency key conflict') {
      super(message)
      this.name = 'IdempotencyConflictError'
    }
  },
  validateIdempotencyKey: mockValidateIdempotencyKey,
  scopeIdempotencyKey: mockScopeIdempotencyKey,
}))

const { verificationsRouter } = await import('../routes/verifications.js')

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

const app = express()
app.use(express.json())
app.use('/api/verifications', verificationsRouter)

function setupHappyPath() {
  mockRecordVerification.mockResolvedValue(MOCK_REC)
  mockCreateAuditLog.mockResolvedValue(MOCK_AUDIT)
  mockCreateEvidenceReference.mockResolvedValue(MOCK_EVIDENCE)
  mockGetIdempotentResponse.mockResolvedValue(null)
  mockHashRequestPayload.mockReturnValue('fake-hash')
  mockValidateIdempotencyKey.mockReturnValue({ valid: true })
  mockScopeIdempotencyKey.mockImplementation((userId: string, key: string) => `${userId}:${key}`)
  mockSaveIdempotentResponse.mockResolvedValue(undefined)
  mockFailPendingIdempotentResponse.mockReturnValue(undefined)
}

describe('verifications idempotency: key validation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  test('returns 400 when idempotency key is invalid', async () => {
    mockValidateIdempotencyKey.mockReturnValue({
      valid: false,
      error: 'Idempotency key must be 1–255 characters and contain only letters, digits, hyphens, and underscores.',
      code: 'INVALID_IDEMPOTENCY_KEY',
    })

    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'invalid key!')
      .send(VALID_BODY)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
    expect(mockRecordVerification).not.toHaveBeenCalled()
    expect(mockGetIdempotentResponse).not.toHaveBeenCalled()
  })

  test('treats empty idempotency key as absent (no idempotency in response)', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', '')
      .send(VALID_BODY)

    expect(res.status).toBe(201)
    expect(res.body.idempotency).toBeUndefined()
  })

  test('returns 400 for idempotency key exceeding 255 characters', async () => {
    mockValidateIdempotencyKey.mockReturnValue({
      valid: false,
      error: 'Idempotency key must be 1–255 characters and contain only letters, digits, hyphens, and underscores.',
      code: 'INVALID_IDEMPOTENCY_KEY',
    })

    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'a'.repeat(256))
      .send(VALID_BODY)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
  })
})

describe('verifications idempotency: first request with key', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  test('returns 201 with idempotency.replayed: false when key is provided and no cached response', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)

    expect(res.status).toBe(201)
    expect(res.body.verification).toMatchObject({ id: 'ver-1' })
    expect(res.body.evidenceReference).toMatchObject({ id: 'ev-1' })
    expect(res.body.idempotency).toEqual({ key: 'my-key-1', replayed: false })
  })

  test('scopes idempotency key with user ID', async () => {
    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)
      .expect(201)

    expect(mockScopeIdempotencyKey).toHaveBeenCalledWith('verifier-1', 'my-key-1')
  })

  test('saves idempotent response with scoped key', async () => {
    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)
      .expect(201)

    expect(mockSaveIdempotentResponse).toHaveBeenCalledWith(
      'verifier-1:my-key-1',
      'fake-hash',
      'ver-1',
      expect.objectContaining({
        verification: expect.objectContaining({ id: 'ver-1' }),
        idempotency: { key: 'my-key-1', replayed: false },
      }),
    )
  })

  test('does not include idempotency in response when no key is provided', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .send(VALID_BODY)

    expect(res.status).toBe(201)
    expect(res.body.idempotency).toBeUndefined()
  })

  test('does not call idempotency functions when no key is provided', async () => {
    await request(app)
      .post('/api/verifications')
      .send(VALID_BODY)
      .expect(201)

    expect(mockValidateIdempotencyKey).not.toHaveBeenCalled()
    expect(mockScopeIdempotencyKey).not.toHaveBeenCalled()
    expect(mockGetIdempotentResponse).not.toHaveBeenCalled()
    expect(mockSaveIdempotentResponse).not.toHaveBeenCalled()
  })
})

describe('verifications idempotency: replay', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  test('returns 200 with cached response when same key and same payload is replayed', async () => {
    const cachedResponse = {
      verification: MOCK_REC,
      evidenceReference: MOCK_EVIDENCE,
    }
    mockGetIdempotentResponse.mockResolvedValue(cachedResponse)

    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)

    expect(res.status).toBe(200)
    expect(res.body.verification).toMatchObject({ id: 'ver-1' })
    expect(res.body.evidenceReference).toMatchObject({ id: 'ev-1' })
    expect(res.body.idempotency).toEqual({ key: 'my-key-1', replayed: true })
  })

  test('does not call recordVerification on replay', async () => {
    const cachedResponse = {
      verification: MOCK_REC,
      evidenceReference: MOCK_EVIDENCE,
    }
    mockGetIdempotentResponse.mockResolvedValue(cachedResponse)

    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)

    expect(mockRecordVerification).not.toHaveBeenCalled()
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
    expect(mockCreateEvidenceReference).not.toHaveBeenCalled()
  })

  test('uses scoped key when calling getIdempotentResponse', async () => {
    const cachedResponse = {
      verification: MOCK_REC,
      evidenceReference: MOCK_EVIDENCE,
    }
    mockGetIdempotentResponse.mockResolvedValue(cachedResponse)

    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)

    expect(mockGetIdempotentResponse).toHaveBeenCalledWith('verifier-1:my-key-1', 'fake-hash')
  })
})

describe('verifications idempotency: conflict', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  test('returns 409 when same key is used with a different payload', async () => {
    const { IdempotencyConflictError } = await import('../services/idempotency.js')
    mockGetIdempotentResponse.mockRejectedValue(new IdempotencyConflictError())

    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send({ ...VALID_BODY, result: 'rejected' })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('does not call recordVerification on conflict', async () => {
    const { IdempotencyConflictError } = await import('../services/idempotency.js')
    mockGetIdempotentResponse.mockRejectedValue(new IdempotencyConflictError())

    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send({ ...VALID_BODY, result: 'rejected' })

    expect(mockRecordVerification).not.toHaveBeenCalled()
  })
})

describe('verifications idempotency: failure path', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  test('calls failPendingIdempotentResponse when recordVerification throws', async () => {
    const conflictErr = new Error('conflict: decision already made')
    conflictErr.name = 'VerificationConflictError'
    mockRecordVerification.mockRejectedValue(conflictErr)

    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)

    expect(res.status).toBe(409)
    expect(mockFailPendingIdempotentResponse).toHaveBeenCalledWith(
      'verifier-1:my-key-1',
      'fake-hash',
      conflictErr,
    )
  })

  test('calls failPendingIdempotentResponse when evidence reference creation throws', async () => {
    const evidenceErr = new Error('Signed URL expired')
    evidenceErr.name = 'EvidenceReferenceValidationError'
    mockCreateEvidenceReference.mockRejectedValue(evidenceErr)

    const res = await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)

    expect(res.status).toBe(400)
    expect(mockFailPendingIdempotentResponse).toHaveBeenCalledWith(
      'verifier-1:my-key-1',
      'fake-hash',
      evidenceErr,
    )
  })

  test('calls failPendingIdempotentResponse on generic error', async () => {
    const genericErr = new Error('something broke')
    mockRecordVerification.mockRejectedValue(genericErr)

    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'my-key-1')
      .send(VALID_BODY)

    expect(mockFailPendingIdempotentResponse).toHaveBeenCalledWith(
      'verifier-1:my-key-1',
      'fake-hash',
      genericErr,
    )
  })

  test('does not call failPendingIdempotentResponse when no key is provided', async () => {
    const genericErr = new Error('something broke')
    mockRecordVerification.mockRejectedValue(genericErr)

    await request(app)
      .post('/api/verifications')
      .send(VALID_BODY)

    expect(mockFailPendingIdempotentResponse).not.toHaveBeenCalled()
  })
})

describe('verifications idempotency: cross-user isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  test('scopes keys by user ID so different users can use the same client key', async () => {
    mockGetIdempotentResponse.mockResolvedValue(null)

    await request(app)
      .post('/api/verifications')
      .set('idempotency-key', 'shared-key')
      .send(VALID_BODY)

    expect(mockScopeIdempotencyKey).toHaveBeenCalledWith('verifier-1', 'shared-key')
    expect(mockGetIdempotentResponse).toHaveBeenCalledWith('verifier-1:shared-key', 'fake-hash')
  })
})

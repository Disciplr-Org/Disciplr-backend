import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

const mockRecordVerification = jest.fn<any>()
const mockListVerifications = jest.fn<any>()
const mockCreateAuditLog = jest.fn<any>()

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'auth-verifier', role: 'VERIFIER' } as any
    next()
  },
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireVerifier: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireActiveVerifier: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.verifier = { userId: 'auth-verifier', status: 'approved', createdAt: new Date().toISOString() } as any
    next()
  },
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  recordVerification: mockRecordVerification,
  listVerifications: mockListVerifications,
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

const { verificationsRouter } = await import('../routes/verifications.js')

const VALID_EVIDENCE_HASH = 'a'.repeat(64)

describe('verification route spoofing protections', () => {
  const app = express()
  app.use(express.json())
  app.use('/api/verifications', verificationsRouter)

  beforeEach(() => {
    mockRecordVerification.mockReset()
    mockListVerifications.mockReset()
    mockCreateAuditLog.mockReset()
  })

  test('uses authenticated verifier identity, not client-supplied body identity', async () => {
    mockRecordVerification.mockResolvedValue({
      id: 'verification-1',
      verifierUserId: 'auth-verifier',
      targetId: 'target-1',
      result: 'approved',
      evidenceHash: VALID_EVIDENCE_HASH,
      disputed: false,
      timestamp: new Date().toISOString(),
    })
    mockCreateEvidenceReference.mockResolvedValue({
      id: 'evidence-1',
      verificationId: 'verification-1',
      evidenceHash: 'hash-0123456789abcdef0123456789abcdef',
      referenceUrl: 'https://example.com/object.pdf?Expires=32503680000&signature=abc',
      expiresAt: new Date('2030-01-01T00:00:00.000Z').toISOString(),
      createdAt: new Date().toISOString(),
    })

    await request(app)
      .post('/api/verifications')
      .send({
        verifierUserId: 'spoofed-verifier',
        userId: 'spoofed-verifier',
        targetId: 'target-1',
        result: 'approved',
        evidenceHash: VALID_EVIDENCE_HASH,
      })
      .expect(201)

    expect(mockRecordVerification).toHaveBeenCalledWith(
      'auth-verifier',
      'target-1',
      'approved',
      false,
      VALID_EVIDENCE_HASH,
    )
  })
})

describe('evidenceHash validation', () => {
  const app = express()
  app.use(express.json())
  app.use('/api/verifications', verificationsRouter)

  beforeEach(() => {
    mockRecordVerification.mockReset()
  })

  test('rejects request when evidenceHash is missing', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .send({ targetId: 'target-1', result: 'approved' })

    expect(res.status).toBe(400)
    expect(mockRecordVerification).not.toHaveBeenCalled()
  })

  test('rejects request when evidenceHash is empty string', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .send({ targetId: 'target-1', result: 'approved', evidenceHash: '   ' })

    expect(res.status).toBe(400)
    expect(mockRecordVerification).not.toHaveBeenCalled()
  })

  test('rejects evidenceHash that is too short', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .send({ targetId: 'target-1', result: 'approved', evidenceHash: 'abc123' })

    expect(res.status).toBe(422)
    expect(mockRecordVerification).not.toHaveBeenCalled()
  })

  test('rejects evidenceHash containing non-hex characters', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .send({ targetId: 'target-1', result: 'approved', evidenceHash: 'z'.repeat(64) })

    expect(res.status).toBe(422)
    expect(mockRecordVerification).not.toHaveBeenCalled()
  })

  test('accepts a valid 64-char SHA-256 hex evidenceHash', async () => {
    mockRecordVerification.mockResolvedValue({
      id: 'verification-2',
      verifierUserId: 'auth-verifier',
      targetId: 'target-2',
      result: 'approved',
      evidenceHash: VALID_EVIDENCE_HASH,
      disputed: false,
      timestamp: new Date().toISOString(),
    })

    const res = await request(app)
      .post('/api/verifications')
      .send({ targetId: 'target-2', result: 'approved', evidenceHash: VALID_EVIDENCE_HASH })

    expect(res.status).toBe(201)
    expect(res.body.verification.evidenceHash).toBe(VALID_EVIDENCE_HASH)
  })

  test('normalizes evidenceHash to lowercase before passing to service', async () => {
    const upperHash = 'A'.repeat(64)
    mockRecordVerification.mockResolvedValue({
      id: 'verification-3',
      verifierUserId: 'auth-verifier',
      targetId: 'target-3',
      result: 'approved',
      evidenceHash: upperHash.toLowerCase(),
      disputed: false,
      timestamp: new Date().toISOString(),
    })

    await request(app)
      .post('/api/verifications')
      .send({ targetId: 'target-3', result: 'approved', evidenceHash: upperHash })
      .expect(201)

    expect(mockRecordVerification).toHaveBeenCalledWith(
      'auth-verifier',
      'target-3',
      'approved',
      false,
      upperHash.toLowerCase(),
    )
  })
})

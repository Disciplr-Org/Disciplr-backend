import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import fc from 'fast-check'
import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { arbitraryMaliciousHeaders } from './fixtures/rbacArbitraries.js'

process.env.JWT_SECRET = 'verifications-rbac-test-secret'

const mockRecordVerification = jest.fn()
const mockListVerifications = jest.fn()
const mockCreateAuditLog = jest.fn()
const mockCreateEvidenceReference = jest.fn()
const mockTransaction = jest.fn()
const mockRetryWithBackoff = jest.fn()
const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

jest.unstable_mockModule('../db/knex.js', () => ({
  db: {
    transaction: mockTransaction,
  },
}))

jest.unstable_mockModule('../utils/retry.js', () => ({
  retryWithBackoff: mockRetryWithBackoff,
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  recordVerification: mockRecordVerification,
  listVerifications: mockListVerifications,
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

jest.unstable_mockModule('../services/evidence.js', () => ({
  EvidenceReferenceValidationError: class EvidenceReferenceValidationError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'EvidenceReferenceValidationError'
    }
  },
  createEvidenceReference: mockCreateEvidenceReference,
}))

const { verificationsRouter } = await import('../routes/verifications.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

const PROPERTY_RUNS = { numRuns: 25 }
const EVIDENCE_HASH = 'a'.repeat(64)
const EVIDENCE_REFERENCE_URL = 'https://storage.example.test/evidence.pdf?Expires=32503680000'

const validDecisionBody = {
  targetId: 'milestone-1',
  result: 'approved',
  evidenceHash: EVIDENCE_HASH,
  evidenceReferenceUrl: EVIDENCE_REFERENCE_URL,
}
const validDecisionJson = JSON.stringify(validDecisionBody)

function tokenFor(role: UserRole, userId = `test-${role.toLowerCase()}`): string {
  return jwt.sign(
    {
      userId,
      role,
      email: `${userId}@example.test`,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  )
}

function expiredTokenFor(role: UserRole): string {
  return jwt.sign(
    {
      userId: `expired-${role.toLowerCase()}`,
      role,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '-1h' },
  )
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/verifications', verificationsRouter)
  app.use(errorHandler)
  return app
}

describe('verifications RBAC header isolation', () => {
  const app = buildApp()

  beforeEach(() => {
    mockRecordVerification.mockReset()
    mockListVerifications.mockReset()
    mockCreateAuditLog.mockReset()
    mockCreateEvidenceReference.mockReset()
    mockTransaction.mockReset()
    mockRetryWithBackoff.mockReset()

    mockTransaction.mockImplementation(async (callback) => callback({ trx: 'test-transaction' }))
    mockRetryWithBackoff.mockImplementation(async (callback) => callback())
    mockRecordVerification.mockResolvedValue({
      id: 'verification-1',
      verifierUserId: 'test-verifier',
      targetId: validDecisionBody.targetId,
      result: validDecisionBody.result,
      evidenceHash: EVIDENCE_HASH,
      disputed: false,
      timestamp: new Date('2026-06-18T00:00:00.000Z').toISOString(),
    })
    mockCreateEvidenceReference.mockResolvedValue({
      id: 'evidence-1',
      verificationId: 'verification-1',
      evidenceHash: EVIDENCE_HASH,
      referenceUrl: EVIDENCE_REFERENCE_URL,
      expiresAt: new Date('2030-01-01T00:00:00.000Z').toISOString(),
      createdAt: new Date('2026-06-18T00:00:00.000Z').toISOString(),
    })
    mockListVerifications.mockResolvedValue([
      {
        id: 'verification-1',
        verifierUserId: 'test-verifier',
        targetId: validDecisionBody.targetId,
        result: validDecisionBody.result,
      },
    ])
  })

  afterEach(() => {
    consoleWarnSpy.mockClear()
  })

  afterAll(() => {
    consoleWarnSpy.mockRestore()
  })

  it('denies a USER JWT even when headers claim ADMIN privileges', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${tokenFor(UserRole.USER, 'user-with-spoofed-admin-header')}`)
      .set('x-user-role', 'ADMIN')
      .set('x-requested-role', 'SUPERADMIN')
      .send(validDecisionJson)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden')
    expect(mockRecordVerification).not.toHaveBeenCalled()
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })

  it('processes a VERIFIER JWT as the verifier identity despite spoofed role headers', async () => {
    const verifierToken = tokenFor(UserRole.VERIFIER, 'verifier-from-token')

    const res = await request(app)
      .post('/api/verifications')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${verifierToken}`)
      .set('x-requested-role', 'SUPERADMIN')
      .set('x-user-role', 'ADMIN')
      .send(validDecisionJson)

    expect(res.status).toBe(201)
    expect(mockRecordVerification).toHaveBeenCalledWith(
      'verifier-from-token',
      validDecisionBody.targetId,
      validDecisionBody.result,
      false,
      EVIDENCE_HASH,
      { trx: 'test-transaction' },
    )
  })

  it('keeps unauthenticated spoofing attempts at 401 before authorization', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('Content-Type', 'application/json')
      .set('x-user-role', 'ADMIN')
      .set('x-requested-role', 'SUPERADMIN')
      .send(validDecisionJson)

    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/missing|malformed/i)
    expect(mockRecordVerification).not.toHaveBeenCalled()
  })

  it('keeps expired-token spoofing attempts at 401', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${expiredTokenFor(UserRole.ADMIN)}`)
      .set('x-user-role', 'ADMIN')
      .set('x-requested-role', 'SUPERADMIN')
      .send(validDecisionJson)

    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/expired/i)
    expect(mockRecordVerification).not.toHaveBeenCalled()
  })

  it('does not grant GET access to VERIFIER when x-requested-role claims SUPERADMIN', async () => {
    const res = await request(app)
      .get('/api/verifications')
      .set('Authorization', `Bearer ${tokenFor(UserRole.VERIFIER, 'verifier-get')}`)
      .set('x-requested-role', 'SUPERADMIN')

    expect(res.status).toBe(403)
    expect(mockListVerifications).not.toHaveBeenCalled()
  })

  it('enforces the verifier endpoint role matrix', async () => {
    const cases = [
      { method: 'post', role: UserRole.USER, expectedStatus: 403 },
      { method: 'post', role: UserRole.VERIFIER, expectedStatus: 201 },
      { method: 'post', role: UserRole.ADMIN, expectedStatus: 201 },
      { method: 'get', role: UserRole.USER, expectedStatus: 403 },
      { method: 'get', role: UserRole.VERIFIER, expectedStatus: 403 },
      { method: 'get', role: UserRole.ADMIN, expectedStatus: 200 },
    ] as const

    for (const testCase of cases) {
      const response =
        testCase.method === 'post'
          ? await request(app)
              .post('/api/verifications')
              .set('Content-Type', 'application/json')
              .set('Authorization', `Bearer ${tokenFor(testCase.role, `${testCase.role}-matrix`)}`)
              .send(validDecisionJson)
          : await request(app)
              .get('/api/verifications')
              .set('Authorization', `Bearer ${tokenFor(testCase.role, `${testCase.role}-matrix`)}`)

      expect(response.status).toBe(testCase.expectedStatus)
    }
  })

  it('denies generated malicious role headers for USER JWTs', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryMaliciousHeaders(), async (headers) => {
        let req = request(app)
          .post('/api/verifications')
          .set('Content-Type', 'application/json')
          .set('Authorization', `Bearer ${tokenFor(UserRole.USER, 'property-user')}`)

        for (const [header, value] of Object.entries(headers)) {
          req = req.set(header, value)
        }

        const res = await req.send(validDecisionJson)

        expect(res.status).toBe(403)
      }),
      PROPERTY_RUNS,
    )
  })

  it('keeps generated malicious role headers unauthorized without a JWT', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryMaliciousHeaders(), async (headers) => {
        let req = request(app).post('/api/verifications').set('Content-Type', 'application/json')

        for (const [header, value] of Object.entries(headers)) {
          req = req.set(header, value)
        }

        const res = await req.send(validDecisionJson)

        expect(res.status).toBe(401)
      }),
      PROPERTY_RUNS,
    )
  })
})

/**
 * Tests for #1529 — Verifications route bounded performance and visibility.
 *
 * Covers:
 *   - Paginated GET / admin list (limit cap, default, offset, hasMore)
 *   - Per-verifier bulk in-flight deduplication guard (400 on concurrent bulk)
 *   - Structured diagnostic emission on bulk completion
 *   - Success, failure, and boundary behaviour for list pagination
 */

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { UserRole } from '../types/user.js'

process.env.JWT_SECRET = 'verifications-quorum-test-secret'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRecordVerification = jest.fn()
const mockListVerifications = jest.fn()
const mockCreateAuditLog = jest.fn()
const mockCreateEvidenceReference = jest.fn()
const mockTransaction = jest.fn()
const mockRetryWithBackoff = jest.fn()

jest.unstable_mockModule('../db/knex.js', () => ({
  db: { transaction: mockTransaction },
}))

jest.unstable_mockModule('../utils/retry.js', () => ({
  retryWithBackoff: mockRetryWithBackoff,
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  recordVerification: mockRecordVerification,
  listVerifications: mockListVerifications,
  VerificationConflictError: class VerificationConflictError extends Error {
    constructor() {
      super('conflict: decision already made')
      this.name = 'VerificationConflictError'
    }
  },
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function tokenFor(role: UserRole, userId = `test-${role.toLowerCase()}`): string {
  return jwt.sign(
    { userId, role, email: `${userId}@example.test` },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  )
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/verifications', verificationsRouter)
  app.use(errorHandler)
  return app
}

const adminToken = tokenFor(UserRole.ADMIN, 'admin-list')
const verifierToken = tokenFor(UserRole.VERIFIER, 'verifier-bulk')

const EVIDENCE_HASH = 'a'.repeat(64)
const EVIDENCE_URL = 'https://storage.example.test/evidence.pdf?Expires=32503680000'

const stubVerification = {
  id: 'v-1',
  verifierUserId: 'verifier-bulk',
  targetId: 'target-1',
  result: 'approved',
  evidenceHash: EVIDENCE_HASH,
  disputed: false,
  timestamp: '2026-01-01T00:00:00.000Z',
}

const stubEvidenceRef = {
  id: 'er-1',
  verificationId: 'v-1',
  evidenceHash: EVIDENCE_HASH,
  referenceUrl: EVIDENCE_URL,
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function makeBulkItem(targetId: string) {
  return {
    targetId,
    result: 'approved',
    evidenceHash: EVIDENCE_HASH,
    evidenceReferenceUrl: EVIDENCE_URL,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('#1529 verifications — paginated admin list', () => {
  const app = buildApp()

  beforeEach(() => {
    mockListVerifications.mockReset()
    mockListVerifications.mockResolvedValue([])
  })

  it('returns pagination metadata alongside verifications', async () => {
    mockListVerifications.mockResolvedValue([stubVerification])

    const res = await request(app)
      .get('/api/verifications')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('pagination')
    expect(res.body.pagination).toMatchObject({
      limit: expect.any(Number),
      offset: 0,
      count: 1,
    })
    expect(typeof res.body.pagination.hasMore).toBe('boolean')
  })

  it('defaults to limit=100 and offset=0', async () => {
    await request(app)
      .get('/api/verifications')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(mockListVerifications).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ limit: 100, offset: 0 }),
    )
  })

  it('respects explicit limit and offset params', async () => {
    await request(app)
      .get('/api/verifications?limit=25&offset=50')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(mockListVerifications).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ limit: 25, offset: 50 }),
    )
  })

  it('caps limit at MAX_VERIFICATIONS_PAGE_LIMIT (500) when a larger value is requested', async () => {
    await request(app)
      .get('/api/verifications?limit=9999')
      .set('Authorization', `Bearer ${adminToken}`)

    const [, [, opts]] = mockListVerifications.mock.calls as [any, [any, any]][]
    expect((opts as any).limit).toBeLessThanOrEqual(500)
  })

  it('sets hasMore=true when the page is exactly the limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ ...stubVerification, id: `v-${i}` }))
    mockListVerifications.mockResolvedValue(items)

    const res = await request(app)
      .get('/api/verifications?limit=10')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.body.pagination.hasMore).toBe(true)
  })

  it('sets hasMore=false when fewer items are returned than the limit', async () => {
    mockListVerifications.mockResolvedValue([stubVerification])

    const res = await request(app)
      .get('/api/verifications?limit=10')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.body.pagination.hasMore).toBe(false)
  })

  it('returns 403 for VERIFIER role on GET /', async () => {
    const res = await request(app)
      .get('/api/verifications')
      .set('Authorization', `Bearer ${verifierToken}`)

    expect(res.status).toBe(403)
    expect(mockListVerifications).not.toHaveBeenCalled()
  })

  it('treats non-numeric limit as default (100)', async () => {
    await request(app)
      .get('/api/verifications?limit=abc')
      .set('Authorization', `Bearer ${adminToken}`)

    const [, [, opts]] = mockListVerifications.mock.calls as [any, [any, any]][]
    expect((opts as any).limit).toBe(100)
  })
})

describe('#1529 verifications — bulk in-flight guard', () => {
  const app = buildApp()

  beforeEach(() => {
    mockTransaction.mockReset()
    mockRetryWithBackoff.mockReset()
    mockRecordVerification.mockReset()
    mockCreateAuditLog.mockReset()
    mockCreateEvidenceReference.mockReset()

    mockTransaction.mockImplementation(async (cb: any) => cb({}))
    mockCreateAuditLog.mockResolvedValue({ id: 'al-1' })
    mockCreateEvidenceReference.mockResolvedValue(stubEvidenceRef)
  })

  it('returns 400 when a second bulk request is sent while one is still in-flight for the same verifier', async () => {
    // First bulk call blocks indefinitely until we resolve it manually.
    let resolveFirst!: (v: any) => void
    const firstBlocker = new Promise<any>((res) => { resolveFirst = res })

    mockRetryWithBackoff.mockImplementationOnce(() => firstBlocker)
    mockRetryWithBackoff.mockImplementation(async (cb: any) => cb())
    mockRecordVerification.mockResolvedValue(stubVerification)

    const first = request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send([makeBulkItem('target-1')])

    // Let the event loop tick so the first request enters the handler
    await new Promise((r) => setImmediate(r))

    // Second concurrent bulk from same verifier
    const second = await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send([makeBulkItem('target-2')])

    expect(second.status).toBe(400)
    expect(second.body.error).toHaveProperty('message')
    expect(second.body.error.message).toMatch(/in progress|bulk/i)

    resolveFirst(stubVerification)
    await first
  })

  it('allows a second bulk request after the first completes', async () => {
    mockRetryWithBackoff.mockImplementation(async (cb: any) => cb())
    mockRecordVerification.mockResolvedValue(stubVerification)

    const first = await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send([makeBulkItem('target-1')])

    expect(first.status).toBe(200)

    const second = await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send([makeBulkItem('target-2')])

    expect(second.status).toBe(200)
  })

  it('two different verifiers can run bulk submissions concurrently without interference', async () => {
    const verifierToken2 = tokenFor(UserRole.VERIFIER, 'verifier-2')

    let resolveFirst!: (v: any) => void
    const firstBlocker = new Promise<any>((res) => { resolveFirst = res })

    // verifier-bulk blocks; verifier-2 uses normal mock
    mockRetryWithBackoff
      .mockImplementationOnce(() => firstBlocker)  // first call (verifier-bulk)
      .mockImplementation(async (cb: any) => cb())  // subsequent calls (verifier-2)
    mockRecordVerification.mockResolvedValue(stubVerification)

    const first = request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send([makeBulkItem('target-A')])

    await new Promise((r) => setImmediate(r))

    // Different verifier should NOT be blocked
    const second = await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken2}`)
      .send([makeBulkItem('target-B')])

    expect(second.status).toBe(200)

    resolveFirst(stubVerification)
    await first
  })
})

describe('#1529 verifications — bulk diagnostic emission', () => {
  const app = buildApp()
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockTransaction.mockReset()
    mockRetryWithBackoff.mockReset()
    mockRecordVerification.mockReset()
    mockCreateAuditLog.mockReset()
    mockCreateEvidenceReference.mockReset()

    mockTransaction.mockImplementation(async (cb: any) => cb({}))
    mockRetryWithBackoff.mockImplementation(async (cb: any) => cb())
    mockCreateAuditLog.mockResolvedValue({ id: 'al-2' })
    mockCreateEvidenceReference.mockResolvedValue(stubEvidenceRef)
    mockRecordVerification.mockResolvedValue(stubVerification)
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('emits a structured diagnostic log after a successful bulk submission', async () => {
    await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send([makeBulkItem('target-diag-1')])

    const jsonLogs = consoleErrorSpy.mock.calls
      .map(([msg]) => { try { return JSON.parse(msg as string) } catch { return null } })
      .filter(Boolean)

    const diagLog = jsonLogs.find((l: any) => l.component === 'verifications' && l.action === 'verification.bulk')
    expect(diagLog).toBeDefined()
    expect(diagLog).toHaveProperty('outcome', 'success')
    expect(diagLog).toHaveProperty('count', 1)
    expect(diagLog).toHaveProperty('latencyMs')
    // Must not include secrets or raw URLs
    expect(JSON.stringify(diagLog)).not.toMatch(/https?:\/\//i)
    expect(JSON.stringify(diagLog)).not.toMatch(/password|token|secret|bearer/i)
  })

  it('emits outcome=partial when some bulk items fail', async () => {
    const { VerificationConflictError } = await import('../services/verifiers.js')
    mockRecordVerification
      .mockResolvedValueOnce(stubVerification)
      .mockRejectedValueOnce(new (VerificationConflictError as any)())

    await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send([makeBulkItem('target-ok'), makeBulkItem('target-conflict')])

    const jsonLogs = consoleErrorSpy.mock.calls
      .map(([msg]) => { try { return JSON.parse(msg as string) } catch { return null } })
      .filter(Boolean)

    const diagLog = jsonLogs.find((l: any) => l.component === 'verifications' && l.action === 'verification.bulk')
    expect(diagLog).toBeDefined()
    expect(diagLog.outcome).toBe('partial')
    expect(diagLog.count).toBe(2)
  })
})

describe('#1529 verifications — bulk boundary invariants', () => {
  const app = buildApp()

  beforeEach(() => {
    mockTransaction.mockReset()
    mockRetryWithBackoff.mockReset()
    mockRecordVerification.mockReset()
    mockCreateAuditLog.mockReset()
    mockCreateEvidenceReference.mockReset()

    mockTransaction.mockImplementation(async (cb: any) => cb({}))
    mockRetryWithBackoff.mockImplementation(async (cb: any) => cb())
    mockCreateAuditLog.mockResolvedValue({ id: 'al-3' })
    mockCreateEvidenceReference.mockResolvedValue(stubEvidenceRef)
    mockRecordVerification.mockResolvedValue(stubVerification)
  })

  it('returns 400 when batch exceeds MAX_BATCH_SIZE (100)', async () => {
    const items = Array.from({ length: 101 }, (_, i) => makeBulkItem(`t-${i}`))

    const res = await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send(items)

    expect(res.status).toBe(400)
  })

  it('accepts a batch of exactly MAX_BATCH_SIZE (100)', async () => {
    const items = Array.from({ length: 100 }, (_, i) => makeBulkItem(`t-${i}`))

    const res = await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send(items)

    expect(res.status).toBe(200)
    expect(res.body.summary.total).toBe(100)
  })

  it('returns 400 for an empty array', async () => {
    const res = await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send([])

    expect(res.status).toBe(400)
  })

  it('returns 400 when body is not an array', async () => {
    const res = await request(app)
      .post('/api/verifications/bulk')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send({ targetId: 'x' })

    expect(res.status).toBe(400)
  })
})

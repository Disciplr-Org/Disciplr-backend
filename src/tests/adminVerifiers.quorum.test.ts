/**
 * Tests for #1529 — Verifier quorum and administrator transitions:
 * bounded performance and operational visibility.
 *
 * Covers:
 *   - Pagination bounds (limit cap, default, offset, hasMore)
 *   - Structured diagnostic emission on transitions
 *   - X-Request-Id response header
 *   - Concurrent in-flight transition guard (429)
 *   - Full status-transition matrix (success, failure, boundary)
 *   - Reinstate, deactivate, reactivate handlers
 *   - Permission invariants (USER, VERIFIER, ADMIN)
 *   - Invalid userId path param sanitization
 */

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals'
import { UserRole } from '../types/user.js'

process.env.JWT_SECRET = 'adminVerifiers-quorum-test-secret'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockTransitionVerifier = jest.fn()
const mockCreateVerifierProfile = jest.fn()
const mockGetVerifierProfile = jest.fn()
const mockGetVerifierStats = jest.fn()
const mockListVerifierProfiles = jest.fn()
const mockUpdateVerifierProfile = jest.fn()
const mockDeleteVerifierProfile = jest.fn()
const mockIsValidStellarAddress = jest.fn()

jest.unstable_mockModule('../services/verifiers.js', () => ({
  transitionVerifier: mockTransitionVerifier,
  createVerifierProfile: mockCreateVerifierProfile,
  getVerifierProfile: mockGetVerifierProfile,
  getVerifierStats: mockGetVerifierStats,
  listVerifierProfiles: mockListVerifierProfiles,
  updateVerifierProfile: mockUpdateVerifierProfile,
  deleteVerifierProfile: mockDeleteVerifierProfile,
  createOrGetVerifierProfile: jest.fn(),
  InvalidVerifierStatusTransitionError: class InvalidVerifierStatusTransitionError extends Error {
    from: string
    to: string
    constructor(from: string, to: string) {
      super(`Invalid verifier status transition: ${from} -> ${to}`)
      this.name = 'InvalidVerifierStatusTransitionError'
      this.from = from
      this.to = to
    }
  },
}))

jest.unstable_mockModule('../services/vaultValidation.js', () => ({
  isValidStellarAddress: mockIsValidStellarAddress,
}))

const { adminVerifiersRouter } = await import('../routes/adminVerifiers.js')
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
  app.use('/api/admin/verifiers', adminVerifiersRouter)
  app.use(errorHandler)
  return app
}

const adminToken = tokenFor(UserRole.ADMIN, 'admin-actor')
const userToken = tokenFor(UserRole.USER, 'regular-user')
const verifierToken = tokenFor(UserRole.VERIFIER, 'verifier-user')

const baseProfile = {
  userId: 'target-user',
  status: 'pending',
  displayName: 'Test Verifier',
  metadata: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  approvedAt: null,
  suspendedAt: null,
  deactivatedAt: null,
}
const baseStats = { totalVerifications: 5, approvals: 3, rejections: 2, disputes: 0 }

// ── Tests ────────────────────────────────────────────────────────────────────

describe('#1529 adminVerifiers — pagination bounds', () => {
  const app = buildApp()

  beforeEach(() => {
    mockListVerifierProfiles.mockReset()
    mockGetVerifierStats.mockReset()
    mockListVerifierProfiles.mockResolvedValue([])
    mockGetVerifierStats.mockResolvedValue(baseStats)
  })

  it('returns pagination metadata on list response', async () => {
    mockListVerifierProfiles.mockResolvedValue([{ ...baseProfile }])
    mockGetVerifierStats.mockResolvedValue(baseStats)

    const res = await request(app)
      .get('/api/admin/verifiers')
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

  it('defaults to limit=50 and offset=0 when query params are absent', async () => {
    await request(app)
      .get('/api/admin/verifiers')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(mockListVerifierProfiles).toHaveBeenCalledWith({ limit: 50, offset: 0 })
  })

  it('respects explicit limit and offset query params', async () => {
    await request(app)
      .get('/api/admin/verifiers?limit=10&offset=20')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(mockListVerifierProfiles).toHaveBeenCalledWith({ limit: 10, offset: 20 })
  })

  it('caps limit at MAX_PAGE_LIMIT (200) when a larger value is requested', async () => {
    await request(app)
      .get('/api/admin/verifiers?limit=9999')
      .set('Authorization', `Bearer ${adminToken}`)

    const [[calledOpts]] = mockListVerifierProfiles.mock.calls as [any[]][]
    expect(calledOpts.limit).toBeLessThanOrEqual(200)
  })

  it('sets hasMore=true when returned page equals the limit', async () => {
    // Return exactly limit items to signal there may be more pages.
    const profiles = Array.from({ length: 10 }, (_, i) => ({ ...baseProfile, userId: `u-${i}` }))
    mockListVerifierProfiles.mockResolvedValue(profiles)

    const res = await request(app)
      .get('/api/admin/verifiers?limit=10')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.body.pagination.hasMore).toBe(true)
  })

  it('sets hasMore=false when returned page is smaller than the limit', async () => {
    mockListVerifierProfiles.mockResolvedValue([{ ...baseProfile }])

    const res = await request(app)
      .get('/api/admin/verifiers?limit=10')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.body.pagination.hasMore).toBe(false)
  })

  it('treats negative or non-numeric limit as the default (50)', async () => {
    await request(app)
      .get('/api/admin/verifiers?limit=-5')
      .set('Authorization', `Bearer ${adminToken}`)

    const [[calledOpts]] = mockListVerifierProfiles.mock.calls as [any[]][]
    expect(calledOpts.limit).toBe(50)
  })
})

describe('#1529 adminVerifiers — permission invariants', () => {
  const app = buildApp()

  beforeEach(() => {
    mockGetVerifierProfile.mockReset()
    mockTransitionVerifier.mockReset()
    mockGetVerifierStats.mockReset()
    mockListVerifierProfiles.mockReset()
    mockListVerifierProfiles.mockResolvedValue([])
  })

  it('returns 403 for USER role on all mutating endpoints', async () => {
    const endpoints = [
      () => request(app).post('/api/admin/verifiers/u1/approve').set('Authorization', `Bearer ${userToken}`),
      () => request(app).post('/api/admin/verifiers/u1/suspend').set('Authorization', `Bearer ${userToken}`),
      () => request(app).post('/api/admin/verifiers/u1/deactivate').set('Authorization', `Bearer ${userToken}`),
      () => request(app).post('/api/admin/verifiers/u1/reinstate').set('Authorization', `Bearer ${userToken}`),
      () => request(app).post('/api/admin/verifiers/u1/reactivate').set('Authorization', `Bearer ${userToken}`),
      () => request(app).delete('/api/admin/verifiers/u1').set('Authorization', `Bearer ${userToken}`),
      () => request(app).get('/api/admin/verifiers').set('Authorization', `Bearer ${userToken}`),
    ]

    for (const fn of endpoints) {
      const res = await fn()
      expect(res.status).toBe(403)
    }
  })

  it('returns 403 for VERIFIER role on all endpoints', async () => {
    const endpoints = [
      () => request(app).post('/api/admin/verifiers/u1/approve').set('Authorization', `Bearer ${verifierToken}`),
      () => request(app).get('/api/admin/verifiers').set('Authorization', `Bearer ${verifierToken}`),
    ]
    for (const fn of endpoints) {
      const res = await fn()
      expect(res.status).toBe(403)
    }
  })

  it('returns 401 for unauthenticated requests', async () => {
    const res = await request(app).get('/api/admin/verifiers')
    expect(res.status).toBe(401)
  })
})

describe('#1529 adminVerifiers — status transition invariants', () => {
  const app = buildApp()

  beforeEach(() => {
    mockGetVerifierProfile.mockReset()
    mockTransitionVerifier.mockReset()
    mockCreateVerifierProfile.mockReset()
    mockGetVerifierStats.mockReset()
    mockGetVerifierStats.mockResolvedValue(baseStats)
  })

  it('approve: returns 200 and passes reason to transitionVerifier', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'pending' })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-1' },
    })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Background check passed' })

    expect(res.status).toBe(200)
    expect(mockTransitionVerifier).toHaveBeenCalledWith(
      'target-user',
      'approved',
      expect.objectContaining({ actorUserId: 'admin-actor', reason: 'Background check passed' }),
    )
    expect(res.body.profile.status).toBe('approved')
    expect(res.body.auditLogId).toBe('audit-1')
  })

  it('approve: creates profile with status=approved when verifier does not yet exist', async () => {
    mockGetVerifierProfile.mockResolvedValue(undefined)
    mockCreateVerifierProfile.mockResolvedValue({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['user_id', 'status'],
      auditLog: { id: 'audit-2' },
    })

    const res = await request(app)
      .post('/api/admin/verifiers/new-user/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(200)
    expect(mockCreateVerifierProfile).toHaveBeenCalledWith(
      'new-user',
      { status: 'approved' },
      expect.objectContaining({ actorUserId: 'admin-actor' }),
    )
  })

  it('suspend: returns 409 for an invalid transition and includes error message', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'pending' })
    const { InvalidVerifierStatusTransitionError } = await import('../services/verifiers.js')
    mockTransitionVerifier.mockRejectedValue(new (InvalidVerifierStatusTransitionError as any)('pending', 'suspended'))

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/suspend')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'violation' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/invalid.*transition/i)
  })

  it('deactivate: transitions to deactivated and returns changedFields', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'approved' })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'deactivated' },
      changedFields: ['status'],
      auditLog: { id: 'audit-3' },
    })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/deactivate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Inactive account' })

    expect(res.status).toBe(200)
    expect(res.body.profile.status).toBe('deactivated')
    expect(res.body.changedFields).toContain('status')
  })

  it('reactivate: transitions from deactivated to pending', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'deactivated' })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'pending' },
      changedFields: ['status'],
      auditLog: { id: 'audit-4' },
    })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/reactivate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.profile.status).toBe('pending')
  })

  it('deactivate: returns 404 when verifier does not exist', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile })
    mockTransitionVerifier.mockResolvedValue(null)

    const res = await request(app)
      .post('/api/admin/verifiers/unknown-user/deactivate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })
})

describe('#1529 adminVerifiers — reinstate handler', () => {
  const app = buildApp()

  beforeEach(() => {
    mockGetVerifierProfile.mockReset()
    mockTransitionVerifier.mockReset()
    mockGetVerifierStats.mockReset()
    mockGetVerifierStats.mockResolvedValue(baseStats)
  })

  it('returns 200 without transition when verifier is already approved', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'approved' })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/reinstate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(200)
    expect(mockTransitionVerifier).not.toHaveBeenCalled()
    expect(res.body.changedFields).toEqual([])
    expect(res.body.auditLogId).toBeNull()
  })

  it('returns 200 without transition when verifier is already pending', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'pending' })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/reinstate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(200)
    expect(mockTransitionVerifier).not.toHaveBeenCalled()
  })

  it('reinstates a suspended verifier with prior approval to approved', async () => {
    mockGetVerifierProfile.mockResolvedValue({
      ...baseProfile,
      status: 'suspended',
      approvedAt: '2026-02-01T00:00:00.000Z',
    })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-5' },
    })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/reinstate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Reinstating after review' })

    expect(res.status).toBe(200)
    expect(mockTransitionVerifier).toHaveBeenCalledWith(
      'target-user',
      'approved',
      expect.objectContaining({ reason: 'Reinstating after review' }),
    )
    expect(res.body.profile.status).toBe('approved')
  })

  it('reinstates a suspended verifier without prior approval to pending', async () => {
    mockGetVerifierProfile.mockResolvedValue({
      ...baseProfile,
      status: 'suspended',
      approvedAt: null,
    })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'pending' },
      changedFields: ['status'],
      auditLog: { id: 'audit-6' },
    })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/reinstate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(200)
    expect(mockTransitionVerifier).toHaveBeenCalledWith('target-user', 'pending', expect.any(Object))
  })

  it('reinstates a deactivated verifier with approvedAt to approved', async () => {
    mockGetVerifierProfile.mockResolvedValue({
      ...baseProfile,
      status: 'deactivated',
      approvedAt: '2026-01-15T00:00:00.000Z',
    })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-7' },
    })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/reinstate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(200)
    expect(mockTransitionVerifier).toHaveBeenCalledWith('target-user', 'approved', expect.any(Object))
  })

  it('returns 404 when verifier does not exist', async () => {
    mockGetVerifierProfile.mockResolvedValue(undefined)

    const res = await request(app)
      .post('/api/admin/verifiers/unknown/reinstate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })
})

describe('#1529 adminVerifiers — concurrent in-flight transition guard', () => {
  const app = buildApp()

  beforeEach(() => {
    mockGetVerifierProfile.mockReset()
    mockCreateVerifierProfile.mockReset()
    mockTransitionVerifier.mockReset()
    mockGetVerifierStats.mockReset()
    mockGetVerifierStats.mockResolvedValue(baseStats)
  })

  it('returns 429 when a second transition request is made while one is in-flight', async () => {
    // Simulate a slow transition by never resolving the first mock call.
    let resolveFirst!: (v: any) => void
    const firstCallPromise = new Promise((res) => { resolveFirst = res })

    mockGetVerifierProfile
      .mockResolvedValueOnce({ ...baseProfile, status: 'pending' }) // first call: profile exists
      .mockResolvedValueOnce({ ...baseProfile, status: 'pending' }) // second call (concurrent)

    mockTransitionVerifier.mockImplementationOnce(() => firstCallPromise)

    // Launch first request without awaiting it
    const first = request(app)
      .post('/api/admin/verifiers/target-user/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'first' })

    // Give the event loop a tick so the first request can enter the handler
    await new Promise((r) => setImmediate(r))

    // Second concurrent request for the same userId should be rejected with 429
    const second = await request(app)
      .post('/api/admin/verifiers/target-user/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'second' })

    expect(second.status).toBe(429)
    expect(second.body.error).toMatch(/concurrent/i)

    // Clean up: resolve the first request
    resolveFirst({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-8' },
    })
    await first
  })

  it('allows a subsequent transition after the in-flight request completes', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'pending' })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-9' },
    })

    // First request — should succeed
    const first = await request(app)
      .post('/api/admin/verifiers/target-user/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(first.status).toBe(200)

    // Second request after first completed — should also succeed
    const second = await request(app)
      .post('/api/admin/verifiers/target-user/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(second.status).toBe(200)
  })
})

describe('#1529 adminVerifiers — structured diagnostics', () => {
  const app = buildApp()
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockGetVerifierProfile.mockReset()
    mockTransitionVerifier.mockReset()
    mockGetVerifierStats.mockReset()
    mockGetVerifierStats.mockResolvedValue(baseStats)
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('emits a structured diagnostic log on successful transition', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'pending' })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-diag-1' },
    })

    await request(app)
      .post('/api/admin/verifiers/target-user/deactivate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    // At least one console.error call should be a structured JSON log
    const jsonLogs = consoleErrorSpy.mock.calls
      .map(([msg]) => {
        try { return JSON.parse(msg as string) } catch { return null }
      })
      .filter(Boolean)

    const diagLog = jsonLogs.find((l: any) => l.component === 'adminVerifiers')
    expect(diagLog).toBeDefined()
    expect(diagLog).toHaveProperty('action')
    expect(diagLog).toHaveProperty('outcome')
    expect(diagLog).toHaveProperty('requestId')
    expect(diagLog).toHaveProperty('timestamp')
    // Must NOT include secrets or sensitive fields
    expect(JSON.stringify(diagLog)).not.toMatch(/password|token|secret|bearer/i)
  })

  it('emits a warn-level diagnostic on invalid transitions', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'pending' })
    const { InvalidVerifierStatusTransitionError } = await import('../services/verifiers.js')
    mockTransitionVerifier.mockRejectedValue(new (InvalidVerifierStatusTransitionError as any)('pending', 'suspended'))

    await request(app)
      .post('/api/admin/verifiers/target-user/suspend')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    const jsonLogs = consoleErrorSpy.mock.calls
      .map(([msg]) => {
        try { return JSON.parse(msg as string) } catch { return null }
      })
      .filter(Boolean)

    const warnLog = jsonLogs.find((l: any) => l.component === 'adminVerifiers' && l.level === 'warn')
    expect(warnLog).toBeDefined()
    expect(warnLog).toHaveProperty('errorCode', 'INVALID_TRANSITION')
    expect(warnLog).toHaveProperty('fromStatus', 'pending')
    expect(warnLog).toHaveProperty('toStatus', 'suspended')
  })

  it('sets X-Request-Id response header on successful transitions', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'pending' })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-hdr-1' },
    })

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.headers['x-request-id']).toBeDefined()
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$|^[^\s]+$/)
  })

  it('echoes a client-supplied X-Request-Id header in the response', async () => {
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, status: 'pending' })
    mockTransitionVerifier.mockResolvedValue({
      after: { ...baseProfile, status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-hdr-2' },
    })

    const clientRequestId = 'my-client-request-id-123'

    const res = await request(app)
      .post('/api/admin/verifiers/target-user/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', clientRequestId)
      .send({})

    expect(res.headers['x-request-id']).toBe(clientRequestId)
  })
})

describe('#1529 adminVerifiers — userId sanitization boundary', () => {
  const app = buildApp()

  it('returns 400 for a userId that is only whitespace', async () => {
    const res = await request(app)
      .get('/api/admin/verifiers/%20%20')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid userId/)
  })

  it('returns 400 for a userId longer than 128 characters', async () => {
    const longId = 'a'.repeat(129)

    const res = await request(app)
      .get(`/api/admin/verifiers/${longId}`)
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(400)
  })

  it('accepts a userId exactly 128 characters long', async () => {
    const exactId = 'a'.repeat(128)
    mockGetVerifierProfile.mockResolvedValue({ ...baseProfile, userId: exactId })
    mockGetVerifierStats.mockResolvedValue(baseStats)

    const res = await request(app)
      .get(`/api/admin/verifiers/${exactId}`)
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
  })
})

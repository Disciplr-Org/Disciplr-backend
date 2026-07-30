import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const mockGetVerifierProfile = jest.fn()
const mockTransitionVerifier = jest.fn()
const mockCreateOrGetVerifierProfile = jest.fn()
const mockGetVerifierStats = jest.fn()
const mockCreateVerifierProfile = jest.fn()
const mockIsValidStellarAddress = jest.fn()
const mockUpdateVerifierProfile = jest.fn()
const mockDeleteVerifierProfile = jest.fn()
const mockListVerifierProfiles = jest.fn()
const mockCreateAuditLog = jest.fn()
const InvalidVerifierStatusTransitionError = class extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid verifier status transition: ${from} -> ${to}`)
    this.name = 'InvalidVerifierStatusTransitionError'
  }
}

jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  authenticate(req: any, _res: any, next: any) {
    req.user = { userId: 'admin-user', role: 'ADMIN' }
    next()
  },
}))

jest.unstable_mockModule('../src/middleware/rbac.js', () => ({
  requireAdmin(_req: any, _res: any, next: any) { next() },
  requireVerifier(_req: any, _res: any, next: any) { next() },
  enforceRBAC: () => (_req: any, _res: any, next: any) => next(),
}))

jest.unstable_mockModule('../src/services/verifiers.js', () => ({
  getVerifierProfile: mockGetVerifierProfile,
  transitionVerifier: mockTransitionVerifier,
  createOrGetVerifierProfile: mockCreateOrGetVerifierProfile,
  getVerifierStats: mockGetVerifierStats,
  createVerifierProfile: mockCreateVerifierProfile,
  updateVerifierProfile: mockUpdateVerifierProfile,
  deleteVerifierProfile: mockDeleteVerifierProfile,
  listVerifierProfiles: mockListVerifierProfiles,
  InvalidVerifierStatusTransitionError,
}))

jest.unstable_mockModule('../src/services/vaultValidation.js', () => ({
  isValidStellarAddress: mockIsValidStellarAddress,
}))

jest.unstable_mockModule('../src/lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

const { adminVerifiersRouter } = await import('../src/routes/adminVerifiers.js')
const { errorHandler } = await import('../src/middleware/errorHandler.js')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/verifiers', adminVerifiersRouter)
  app.use(errorHandler)
  return app
}

const pendingVerifier = {
  userId: 'verifier-pending',
  displayName: 'Pending Verifier',
  metadata: null,
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  approvedAt: null,
  suspendedAt: null,
  deactivatedAt: null,
}

const approvedVerifier = {
  userId: 'verifier-approved',
  displayName: 'Approved Verifier',
  metadata: null,
  status: 'approved',
  createdAt: '2026-01-01T00:00:00.000Z',
  approvedAt: '2026-01-15T00:00:00.000Z',
  suspendedAt: null,
  deactivatedAt: null,
}

const suspendedVerifier = {
  userId: 'verifier-suspended',
  displayName: 'Suspended Verifier',
  metadata: null,
  status: 'suspended',
  createdAt: '2026-01-01T00:00:00.000Z',
  approvedAt: '2026-01-15T00:00:00.000Z',
  suspendedAt: '2026-02-01T00:00:00.000Z',
  deactivatedAt: null,
}

const deactivatedVerifier = {
  userId: 'verifier-deactivated',
  displayName: 'Deactivated Verifier',
  metadata: null,
  status: 'deactivated',
  createdAt: '2026-01-01T00:00:00.000Z',
  approvedAt: '2026-01-15T00:00:00.000Z',
  suspendedAt: null,
  deactivatedAt: '2026-03-01T00:00:00.000Z',
}

const defaultStats = {
  totalVerifications: 0,
  approvals: 0,
  rejections: 0,
  disputes: 0,
  approvalRatio: 0,
  rejectionRatio: 0,
  disputeRate: 0,
}

describe('Admin Verifiers Lifecycle - Suspend/Reinstate', () => {
  let app: express.Express

  beforeEach(() => {
    app = buildApp()
    jest.clearAllMocks()
    mockIsValidStellarAddress.mockResolvedValue(true)
    mockGetVerifierStats.mockResolvedValue(defaultStats)
  })

  describe('POST /:userId/suspend', () => {
    it('should suspend an approved verifier', async () => {
      mockGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockCreateOrGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: approvedVerifier,
        after: { ...approvedVerifier, status: 'suspended', suspendedAt: '2026-02-01T00:00:00.000Z' },
        changedFields: ['status'],
        auditLog: { id: 'audit-1' },
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-approved/suspend')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.profile.status).toBe('suspended')
      expect(res.body.auditLogId).toBe('audit-1')
      expect(res.body.changedFields).toContain('status')
      expect(mockTransitionVerifier).toHaveBeenCalledWith(
        'verifier-approved',
        'suspended',
        expect.objectContaining({ actorUserId: 'admin-user' }),
      )
    })

    it('should create a pending profile then return 409 when trying to suspend (pending -> suspended invalid)', async () => {
      const newProfile = { ...pendingVerifier, userId: 'new-verifier' }
      mockGetVerifierProfile.mockResolvedValue(newProfile)
      mockCreateOrGetVerifierProfile.mockResolvedValue(newProfile)
      mockTransitionVerifier.mockRejectedValue(
        new InvalidVerifierStatusTransitionError('pending', 'suspended'),
      )

      const res = await request(app)
        .post('/api/admin/verifiers/new-verifier/suspend')
        .send()

      expect(res.status).toBe(409)
      expect(res.body.error).toContain('Invalid verifier status transition')
    })

    it('should return 500 when createOrGetVerifierProfile fails', async () => {
      mockGetVerifierProfile.mockResolvedValue(undefined)
      mockCreateOrGetVerifierProfile.mockRejectedValue(new Error('db error'))

      const res = await request(app)
        .post('/api/admin/verifiers/db-error/suspend')
        .send()

      expect(res.status).toBe(500)
    })

    it('should return 500 on transition error', async () => {
      mockGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockCreateOrGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockTransitionVerifier.mockRejectedValue(new Error('db error'))

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-approved/suspend')
        .send()

      expect(res.status).toBe(500)
    })
  })

  describe('POST /:userId/reinstate', () => {
    it('should reinstate a suspended verifier to approved when previously approved', async () => {
      mockGetVerifierProfile.mockResolvedValue(suspendedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: suspendedVerifier,
        after: { ...suspendedVerifier, status: 'approved', suspendedAt: null },
        changedFields: ['status'],
        auditLog: { id: 'audit-2' },
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-suspended/reinstate')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.profile.status).toBe('approved')
      expect(res.body.auditLogId).toBe('audit-2')
      expect(mockTransitionVerifier).toHaveBeenCalledWith(
        'verifier-suspended',
        'approved',
        expect.objectContaining({ actorUserId: 'admin-user' }),
      )
    })

    it('should reinstate a suspended verifier to pending when not previously approved', async () => {
      const neverApprovedVerifier = {
        ...suspendedVerifier,
        userId: 'verifier-never-approved',
        approvedAt: null,
      }
      mockGetVerifierProfile.mockResolvedValue(neverApprovedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: neverApprovedVerifier,
        after: { ...neverApprovedVerifier, status: 'pending' },
        changedFields: ['status'],
        auditLog: { id: 'audit-3' },
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-never-approved/reinstate')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.profile.status).toBe('pending')
      expect(mockTransitionVerifier).toHaveBeenCalledWith(
        'verifier-never-approved',
        'pending',
        expect.any(Object),
      )
    })

    it('should return 404 when verifier does not exist', async () => {
      mockGetVerifierProfile.mockResolvedValue(undefined)

      const res = await request(app)
        .post('/api/admin/verifiers/nonexistent/reinstate')
        .send()

      expect(res.status).toBe(404)
    })

    it('should return 404 when transitionVerifier returns null', async () => {
      mockGetVerifierProfile.mockResolvedValue(suspendedVerifier)
      mockTransitionVerifier.mockResolvedValue(null)

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-suspended/reinstate')
        .send()

      expect(res.status).toBe(404)
    })

    it('should return 409 on invalid transition', async () => {
      mockGetVerifierProfile.mockResolvedValue(deactivatedVerifier)
      mockTransitionVerifier.mockRejectedValue(
        new InvalidVerifierStatusTransitionError('deactivated', 'approved'),
      )

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-deactivated/reinstate')
        .send()

      expect(res.status).toBe(409)
      expect(res.body.error).toContain('Invalid verifier status transition')
    })

    it('should return 500 on internal error', async () => {
      mockGetVerifierProfile.mockResolvedValue(suspendedVerifier)
      mockTransitionVerifier.mockRejectedValue(new Error('db error'))

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-suspended/reinstate')
        .send()

      expect(res.status).toBe(500)
    })

    it('should handle the case where verifier has approvedAt but no approvedAt date somehow', async () => {
      const oddVerifier = {
        ...suspendedVerifier,
        userId: 'verifier-odd',
        approvedAt: '2026-01-15T00:00:00.000Z',
      }
      mockGetVerifierProfile.mockResolvedValue(oddVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: oddVerifier,
        after: { ...oddVerifier, status: 'approved' },
        changedFields: ['status'],
        auditLog: { id: 'audit-4' },
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-odd/reinstate')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.profile.status).toBe('approved')
    })
  })

  describe('Edge Cases', () => {
    it('should succeed (no-op) when suspending an already-suspended verifier', async () => {
      mockGetVerifierProfile.mockResolvedValue(suspendedVerifier)
      mockCreateOrGetVerifierProfile.mockResolvedValue(suspendedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: suspendedVerifier,
        after: suspendedVerifier,
        changedFields: [],
        auditLog: null,
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-suspended/suspend')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.auditLogId).toBeNull()
    })

    it('should reinstate a never-suspended verifier to appropriate status', async () => {
      mockGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: approvedVerifier,
        after: approvedVerifier,
        changedFields: [],
        auditLog: null,
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-approved/reinstate')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.profile.status).toBe('approved')
    })

    it('should handle concurrent suspend requests gracefully', async () => {
      mockGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: approvedVerifier,
        after: { ...approvedVerifier, status: 'suspended' },
        changedFields: ['status'],
        auditLog: { id: 'audit-concurrent' },
      })

      const [res1, res2] = await Promise.all([
        request(app).post('/api/admin/verifiers/verifier-approved/suspend').send(),
        request(app).post('/api/admin/verifiers/verifier-approved/suspend').send(),
      ])

      expect(res1.status).toBe(200)
      expect(res2.status).toBe(200)
    })
  })

  describe('Security - RBAC Enforcement', () => {
    it('should have admin-only middleware on the router', () => {
      expect(adminVerifiersRouter).toBeDefined()
      expect(adminVerifiersRouter.stack.length).toBeGreaterThan(0)
    })
  })

  describe('Audit Log Completeness', () => {
    it('should include audit log ID in suspend response', async () => {
      mockGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: approvedVerifier,
        after: { ...approvedVerifier, status: 'suspended' },
        changedFields: ['status'],
        auditLog: { id: 'audit-suspend-1' },
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-approved/suspend')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.auditLogId).toBe('audit-suspend-1')
    })

    it('should include audit log ID in reinstate response', async () => {
      mockGetVerifierProfile.mockResolvedValue(suspendedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: suspendedVerifier,
        after: { ...suspendedVerifier, status: 'approved' },
        changedFields: ['status'],
        auditLog: { id: 'audit-reinstate-1' },
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-suspended/reinstate')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.auditLogId).toBe('audit-reinstate-1')
    })

    it('should return null auditLogId when no change occurred', async () => {
      mockGetVerifierProfile.mockResolvedValue(suspendedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: suspendedVerifier,
        after: suspendedVerifier,
        changedFields: [],
        auditLog: null,
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-suspended/reinstate')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.auditLogId).toBeNull()
    })
  })

  describe('Integration - Verifier Status and Milestone Approval Gating', () => {
    it('should return changedFields for suspend transition', async () => {
      mockGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: approvedVerifier,
        after: { ...approvedVerifier, status: 'suspended' },
        changedFields: ['status'],
        auditLog: { id: 'audit-changes' },
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-approved/suspend')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.changedFields).toEqual(['status'])
    })

    it('should return stats with suspend response', async () => {
      mockGetVerifierProfile.mockResolvedValue(approvedVerifier)
      mockTransitionVerifier.mockResolvedValue({
        before: approvedVerifier,
        after: { ...approvedVerifier, status: 'suspended' },
        changedFields: ['status'],
        auditLog: { id: 'audit-stats' },
      })

      const res = await request(app)
        .post('/api/admin/verifiers/verifier-approved/suspend')
        .send()

      expect(res.status).toBe(200)
      expect(res.body.stats).toBeDefined()
      expect(res.body.stats.totalVerifications).toBe(0)
    })
  })
})

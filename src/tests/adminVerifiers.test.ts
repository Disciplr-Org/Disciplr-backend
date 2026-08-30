import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals'
import { UserRole } from '../types/user.js'

process.env.JWT_SECRET = 'admin-verifiers-test-secret'

const mockTransitionVerifier = jest.fn()
const mockCreateVerifierProfile = jest.fn()
const mockCreateOrTransitionVerifier = jest.fn()
const mockDeleteVerifierProfile = jest.fn()
const mockGetVerifierProfile = jest.fn()
const mockGetVerifierStats = jest.fn()
const mockDeleteVerifierProfile = jest.fn()
const mockUpdateVerifierProfile = jest.fn()
const mockListVerifierProfiles = jest.fn()
const mockCreateOrGetVerifierProfile = jest.fn()

jest.unstable_mockModule('../services/verifiers.js', () => ({
  transitionVerifier: mockTransitionVerifier,
  createVerifierProfile: mockCreateVerifierProfile,
  createOrTransitionVerifier: mockCreateOrTransitionVerifier,
  deleteVerifierProfile: mockDeleteVerifierProfile,
  getVerifierProfile: mockGetVerifierProfile,
  getVerifierStats: mockGetVerifierStats,
  deleteVerifierProfile: mockDeleteVerifierProfile,
  updateVerifierProfile: mockUpdateVerifierProfile,
  listVerifierProfiles: mockListVerifierProfiles,
  createOrGetVerifierProfile: mockCreateOrGetVerifierProfile,
  InvalidVerifierStatusTransitionError: class InvalidVerifierStatusTransitionError extends Error {
    constructor(from: string, to: string) {
      super(`Invalid transition from ${from} to ${to}`)
    }
  },
}))

const { adminVerifiersRouter } = await import('../routes/adminVerifiers.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

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

describe('adminVerifiers', () => {
  const app = buildApp()

  beforeEach(() => {
    mockTransitionVerifier.mockReset()
    mockCreateVerifierProfile.mockReset()
    mockCreateOrTransitionVerifier.mockReset()
    mockDeleteVerifierProfile.mockReset()
    mockGetVerifierProfile.mockReset()
    mockGetVerifierStats.mockReset()
    mockDeleteVerifierProfile.mockReset()
    mockUpdateVerifierProfile.mockReset()
    mockListVerifierProfiles.mockReset()
    mockCreateOrGetVerifierProfile.mockReset()
  })

  it('allows ADMIN to transition verifier status and passes reason', async () => {
    mockCreateOrTransitionVerifier.mockResolvedValue({
      after: { userId: 'user-1', status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-1' }
    })
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 0 })

    const res = await request(app)
      .post('/api/admin/verifiers/user-1/approve')
      .set('Authorization', `Bearer ${tokenFor(UserRole.ADMIN, 'admin-1')}`)
      .send({ reason: 'Looks good' })

    expect(res.status).toBe(200)
    expect(mockCreateOrTransitionVerifier).toHaveBeenCalledWith(
      'user-1',
      'approved',
      { actorUserId: 'admin-1', reason: 'Looks good' }
    )
  })

  it('denies USER from accessing admin routes', async () => {
    const res = await request(app)
      .post('/api/admin/verifiers/user-1/approve')
      .set('Authorization', `Bearer ${tokenFor(UserRole.USER, 'user-1')}`)
      .send({ reason: 'Looks good' })

    expect(res.status).toBe(403)
  })

  it('returns 409 for invalid transitions', async () => {
    // Require dynamic import to get the mocked error class
    const { InvalidVerifierStatusTransitionError } = await import('../services/verifiers.js')
    
    mockCreateOrTransitionVerifier.mockRejectedValue(new InvalidVerifierStatusTransitionError('pending', 'suspended'))

    const res = await request(app)
      .post('/api/admin/verifiers/user-1/suspend')
      .set('Authorization', `Bearer ${tokenFor(UserRole.ADMIN, 'admin-1')}`)
      .send({ reason: 'suspending' })

    expect(res.status).toBe(409)
  })

  it('creates verifier with initial status if not exists', async () => {
    mockCreateOrTransitionVerifier.mockResolvedValue({
      after: { userId: 'user-2', status: 'approved' },
      changedFields: ['status'],
      auditLog: { id: 'audit-2' }
    })
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 0 })

    const res = await request(app)
      .post('/api/admin/verifiers/user-2/approve')
      .set('Authorization', `Bearer ${tokenFor(UserRole.ADMIN, 'admin-1')}`)
      .send({ reason: 'Pre-approved' })

    expect(res.status).toBe(200)
    expect(mockCreateOrTransitionVerifier).toHaveBeenCalledWith(
      'user-2',
      'approved',
      { actorUserId: 'admin-1', reason: 'Pre-approved' }
    )
  })
})

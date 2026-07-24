import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

const mockAuthenticate = jest.fn((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  const role = req.headers['x-test-role']
  if (!role) {
    _res.status(401).json({ error: 'Missing or malformed Authorization header' })
    return
  }

  req.user = { userId: 'test-admin', role: String(role) } as any
  next()
})

const mockRequireAdmin = jest.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ error: `Forbidden: requires role ADMIN, got '${req.user?.role ?? 'unknown'}'` })
    return
  }

  next()
})

const mockListVerifierProfiles: any = jest.fn()
const mockGetVerifierProfile: any = jest.fn()
const mockGetVerifierStats: any = jest.fn()
const mockCreateVerifierProfile: any = jest.fn()
const mockUpdateVerifierProfile: any = jest.fn()
const mockDeleteVerifierProfile: any = jest.fn()
const mockCreateOrGetVerifierProfile: any = jest.fn()
const mockTransitionVerifier: any = jest.fn()

class MockInvalidVerifierStatusTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid verifier status transition: ${from} -> ${to}`)
  }
}

jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  authenticate: mockAuthenticate,
}))

jest.unstable_mockModule('../src/middleware/rbac.js', () => ({
  requireAdmin: mockRequireAdmin,
}))

jest.unstable_mockModule('../src/services/verifiers.js', () => ({
  listVerifierProfiles: mockListVerifierProfiles,
  getVerifierProfile: mockGetVerifierProfile,
  getVerifierStats: mockGetVerifierStats,
  createVerifierProfile: mockCreateVerifierProfile,
  updateVerifierProfile: mockUpdateVerifierProfile,
  deleteVerifierProfile: mockDeleteVerifierProfile,
  createOrGetVerifierProfile: mockCreateOrGetVerifierProfile,
  transitionVerifier: mockTransitionVerifier,
  InvalidVerifierStatusTransitionError: MockInvalidVerifierStatusTransitionError,
}))

const { adminVerifiersRouter } = await import('../src/routes/adminVerifiers.js')

describe('admin verifiers route CRUD coverage', () => {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/verifiers', adminVerifiersRouter)

  beforeEach(() => {
    ;[
      mockListVerifierProfiles,
      mockGetVerifierProfile,
      mockGetVerifierStats,
      mockCreateVerifierProfile,
      mockUpdateVerifierProfile,
      mockDeleteVerifierProfile,
      mockCreateOrGetVerifierProfile,
      mockTransitionVerifier,
    ].forEach((mock) => mock.mockReset())
  })

  test('enforces admin-only access', async () => {
    await request(app).get('/api/admin/verifiers').expect(401)

    const forbidden = await request(app).get('/api/admin/verifiers').set('x-test-role', 'USER').expect(403)
    expect(forbidden.body.error).toContain('requires role ADMIN')
  })

  test('lists verifiers with stats', async () => {
    mockListVerifierProfiles.mockResolvedValue([{ userId: 'v1', status: 'approved' }])
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 3 })

    const response = await request(app).get('/api/admin/verifiers').set('x-test-role', 'ADMIN').expect(200)

    expect(response.body.verifiers).toEqual([{ profile: { userId: 'v1', status: 'approved' }, stats: { totalVerifications: 3 } }])
  })

  test('creates verifier with validation and duplicate conflict handling', async () => {
    await request(app).post('/api/admin/verifiers').set('x-test-role', 'ADMIN').send({}).expect(400)

    await request(app).post('/api/admin/verifiers').set('x-test-role', 'ADMIN').send({ userId: 'a', displayName: 42 }).expect(400)
    await request(app).post('/api/admin/verifiers').set('x-test-role', 'ADMIN').send({ userId: 'a', metadata: [] }).expect(400)
    await request(app).post('/api/admin/verifiers').set('x-test-role', 'ADMIN').send({ userId: 'a', status: 'bad' }).expect(400)

    mockCreateVerifierProfile.mockResolvedValue({ after: { userId: 'v2', status: 'pending' }, auditLog: { id: 'audit-create' } })
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 0 })
    const created = await request(app).post('/api/admin/verifiers').set('x-test-role', 'ADMIN').send({ userId: 'v2' }).expect(201)
    expect(created.body.profile.userId).toBe('v2')
    expect(created.body.auditLogId).toBe('audit-create')
    expect(mockCreateVerifierProfile).toHaveBeenCalledWith('v2', { displayName: undefined, metadata: undefined, status: undefined }, { actorUserId: 'test-admin' })

    mockCreateVerifierProfile.mockRejectedValueOnce({ code: 'SQLITE_CONSTRAINT' })
    await request(app).post('/api/admin/verifiers').set('x-test-role', 'ADMIN').send({ userId: 'v2' }).expect(409)
  })

  test('gets, updates, and deletes verifiers', async () => {
    mockGetVerifierProfile.mockResolvedValueOnce(undefined)
    await request(app).get('/api/admin/verifiers/nope').set('x-test-role', 'ADMIN').expect(404)

    mockGetVerifierProfile.mockResolvedValueOnce({ userId: 'v3', status: 'approved' })
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 1 })
    await request(app).get('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').expect(200)

    await request(app).patch('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').send({ status: 'bad' }).expect(400)

    await request(app).patch('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').send({ displayName: 123 }).expect(400)
    await request(app).patch('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').send({ metadata: [] }).expect(400)

    mockUpdateVerifierProfile.mockResolvedValueOnce(null)
    await request(app).patch('/api/admin/verifiers/missing').set('x-test-role', 'ADMIN').send({ displayName: 'x' }).expect(404)

    mockUpdateVerifierProfile.mockResolvedValueOnce({
      after: { userId: 'v3', status: 'suspended', displayName: 'x' },
      auditLog: { id: 'audit-update' },
      changedFields: ['display_name', 'status'],
    })
    const updated = await request(app).patch('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').send({ displayName: 'x', status: 'suspended' }).expect(200)
    expect(updated.body.auditLogId).toBe('audit-update')
    expect(updated.body.changedFields).toEqual(['display_name', 'status'])

    mockUpdateVerifierProfile.mockRejectedValueOnce(new MockInvalidVerifierStatusTransitionError('deactivated', 'approved'))
    await request(app).patch('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').send({ status: 'approved' }).expect(409)

    mockUpdateVerifierProfile.mockRejectedValueOnce(new Error('db down'))
    await request(app).patch('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').send({ displayName: 'y' }).expect(500)

    mockUpdateVerifierProfile.mockResolvedValueOnce({
      after: { userId: 'v3', status: 'suspended', displayName: 'x' },
      auditLog: null,
      changedFields: [],
    })
    const noop = await request(app).patch('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').send({ displayName: 'x' }).expect(200)
    expect(noop.body.auditLogId).toBeNull()

    mockDeleteVerifierProfile.mockResolvedValueOnce(false)
    await request(app).delete('/api/admin/verifiers/missing').set('x-test-role', 'ADMIN').expect(404)

    mockDeleteVerifierProfile.mockResolvedValueOnce({ deleted: true })
    await request(app).delete('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').expect(204)
  })


  test('propagates unexpected create errors to express error handler', async () => {
    mockCreateVerifierProfile.mockRejectedValueOnce('unexpected-failure')

    await request(app)
      .post('/api/admin/verifiers')
      .set('x-test-role', 'ADMIN')
      .send({ userId: 'v9' })
      .expect(500)
  })

  test('supports legacy approve/suspend actions', async () => {
    mockCreateOrGetVerifierProfile.mockResolvedValue({ userId: 'legacy' })
    mockTransitionVerifier.mockResolvedValue({ after: { userId: 'legacy', status: 'approved' }, auditLog: { id: 'audit-approve' }, changedFields: ['status'] })
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 0 })

    const approved = await request(app).post('/api/admin/verifiers/legacy/approve').set('x-test-role', 'ADMIN').expect(200)
    expect(approved.body.auditLogId).toBe('audit-approve')
    expect(mockTransitionVerifier).toHaveBeenCalledWith('legacy', 'approved', { actorUserId: 'test-admin' })

    mockTransitionVerifier.mockResolvedValueOnce({ after: { userId: 'legacy', status: 'suspended' }, auditLog: { id: 'audit-suspend' }, changedFields: ['status'] })
    await request(app).post('/api/admin/verifiers/legacy/suspend').set('x-test-role', 'ADMIN').expect(200)
    expect(mockTransitionVerifier).toHaveBeenCalledWith('legacy', 'suspended', { actorUserId: 'test-admin' })
  })

  test('supports explicit deactivate/reactivate lifecycle actions', async () => {
    mockTransitionVerifier.mockResolvedValueOnce({ after: { userId: 'v4', status: 'deactivated' }, auditLog: { id: 'audit-deactivate' }, changedFields: ['status'] })
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 0 })

    const deactivated = await request(app).post('/api/admin/verifiers/v4/deactivate').set('x-test-role', 'ADMIN').expect(200)
    expect(deactivated.body.profile.status).toBe('deactivated')
    expect(deactivated.body.auditLogId).toBe('audit-deactivate')

    mockTransitionVerifier.mockResolvedValueOnce({ after: { userId: 'v4', status: 'pending' }, auditLog: { id: 'audit-reactivate' }, changedFields: ['status'] })
    const reactivated = await request(app).post('/api/admin/verifiers/v4/reactivate').set('x-test-role', 'ADMIN').expect(200)
    expect(reactivated.body.profile.status).toBe('pending')
    expect(reactivated.body.auditLogId).toBe('audit-reactivate')
  })

  test('handles lifecycle transition errors', async () => {
    mockTransitionVerifier.mockResolvedValueOnce(null)
    await request(app).post('/api/admin/verifiers/missing/deactivate').set('x-test-role', 'ADMIN').expect(404)

    mockCreateOrGetVerifierProfile.mockRejectedValueOnce(new Error('db down'))
    await request(app).post('/api/admin/verifiers/v5/approve').set('x-test-role', 'ADMIN').expect(500)

    mockTransitionVerifier.mockRejectedValueOnce(new MockInvalidVerifierStatusTransitionError('deactivated', 'approved'))
    await request(app).post('/api/admin/verifiers/v5/approve').set('x-test-role', 'ADMIN').expect(409)

    mockTransitionVerifier.mockRejectedValueOnce(new Error('db down'))
    await request(app).post('/api/admin/verifiers/v5/deactivate').set('x-test-role', 'ADMIN').expect(500)
  })

  test('prevents verifier-role self-promotion on admin verifier endpoints', async () => {
    await request(app)
      .post('/api/admin/verifiers')
      .set('x-test-role', 'VERIFIER')
      .send({ userId: 'test-admin', status: 'approved' })
      .expect(403)
  })
})

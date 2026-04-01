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
const mockSetVerifierStatus: any = jest.fn()

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
  setVerifierStatus: mockSetVerifierStatus,
}))

const { adminVerifiersRouter } = await import('../src/routes/adminVerifiers.js')

describe('admin verifiers route CRUD coverage', () => {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/verifiers', adminVerifiersRouter)

  beforeEach(() => {
    jest.clearAllMocks()
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

    mockCreateVerifierProfile.mockResolvedValue({ userId: 'v2', status: 'pending' })
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 0 })
    const created = await request(app).post('/api/admin/verifiers').set('x-test-role', 'ADMIN').send({ userId: 'v2' }).expect(201)
    expect(created.body.profile.userId).toBe('v2')

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

    mockUpdateVerifierProfile.mockResolvedValueOnce({ userId: 'v3', status: 'suspended', displayName: 'x' })
    await request(app).patch('/api/admin/verifiers/v3').set('x-test-role', 'ADMIN').send({ displayName: 'x', status: 'suspended' }).expect(200)

    mockDeleteVerifierProfile.mockResolvedValueOnce(false)
    await request(app).delete('/api/admin/verifiers/missing').set('x-test-role', 'ADMIN').expect(404)

    mockDeleteVerifierProfile.mockResolvedValueOnce(true)
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
    mockSetVerifierStatus.mockResolvedValue({ userId: 'legacy', status: 'approved' })
    mockGetVerifierStats.mockResolvedValue({ totalVerifications: 0 })

    await request(app).post('/api/admin/verifiers/legacy/approve').set('x-test-role', 'ADMIN').expect(200)
    expect(mockSetVerifierStatus).toHaveBeenCalledWith('legacy', 'approved')

    mockSetVerifierStatus.mockResolvedValueOnce({ userId: 'legacy', status: 'suspended' })
    await request(app).post('/api/admin/verifiers/legacy/suspend').set('x-test-role', 'ADMIN').expect(200)
    expect(mockSetVerifierStatus).toHaveBeenCalledWith('legacy', 'suspended')
  })
})

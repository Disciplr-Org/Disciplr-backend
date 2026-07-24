import { describe, test, expect, beforeEach, afterEach, jest} from '@jest/globals'
import request from 'supertest'
import { app } from '../app'
import { createAuditLog } from '../lib/audit-logs'
import { generateAccessToken,  verifyAccessToken } from '../lib/auth-utils'
import { UserRole } from '../types/user'
import { resetExportJobs } from '../services/exportQueue'

// Mock services
jest.mock('../lib/audit-logs', () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: 'audit-123' } as never),
  getAuditLogById: jest.fn().mockResolvedValue(null as never),
  listAuditLogs: jest.fn().mockResolvedValue([] as never)
}))

jest.mock('../services/session', () => ({
  recordSession: jest.fn().mockResolvedValue(undefined as never),
  validateSession: jest.fn().mockResolvedValue(true as never),
  forceRevokeUserSessions: jest.fn().mockResolvedValue(undefined as never),
  revokeAllUserSessions: jest.fn().mockResolvedValue(undefined as never)
}))

jest.mock('../lib/prismaScope', () => ({
  getPrisma: jest.fn(() => ({
    user: {
      findUnique: jest.fn().mockImplementation((args: any) => {
        const where = args.where
        if (where.id === 'target-user-id') {
          return { id: 'target-user-id', role: UserRole.USER }
        }
        if (where.id === 'target-verifier-id') {
          return { id: 'target-verifier-id', role: UserRole.VERIFIER }
        }
        return null
      })
    }
  }))
}))

jest.mock('../middleware/stepUp', () => ({
  requireStepUp: jest.fn(() => (req: any, res: any, next: any) => next())
}))

describe('Admin Impersonation', () => {
  let adminToken: string
  let nonAdminToken: string
  const adminUserId = 'admin-user-id'
  const targetUserId = 'target-user-id'
  const targetVerifierId = 'target-verifier-id'
  const nonAdminUserId = 'non-admin-user-id'

  beforeEach(() => {
    jest.clearAllMocks()
    adminToken = generateAccessToken({ userId: adminUserId, role: UserRole.ADMIN })
    nonAdminToken = generateAccessToken({ userId: nonAdminUserId, role: UserRole.USER })
  })

  afterEach(() => {
    resetExportJobs()
  })

  test('admin can request impersonation token for a user', async () => {
    const response = await request(app)
      .post(`/api/admin/impersonate/${targetUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)

    expect(response.body.accessToken).toBeDefined()
    expect(response.body.expiresAt).toBeDefined()
    expect(response.body.userId).toBe(targetUserId)
    expect(response.body.role).toBe(UserRole.USER)
    
    // Verify audit log was created
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'impersonation.start',
        target_id: targetUserId,
        actor_user_id: adminUserId
      })
    )

    // Verify token payload
    const payload = verifyAccessToken(response.body.accessToken)
    expect(payload.impersonator).toBe(adminUserId)
    expect(payload.userId).toBe(targetUserId)
    expect(payload.role).toBe(UserRole.USER)
  })

  test('admin can request impersonation token for a verifier', async () => {
    const response = await request(app)
      .post(`/api/admin/impersonate/${targetVerifierId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)

    expect(response.body.role).toBe(UserRole.VERIFIER)
  })

  test('non-admin cannot request impersonation token', async () => {
    await request(app)
      .post(`/api/admin/impersonate/${targetUserId}`)
      .set('Authorization', `Bearer ${nonAdminToken}`)
      .expect(403)
  })

  test('impersonation token cannot access admin endpoints', async () => {
    // First get an impersonation token
    const impersonationRes = await request(app)
      .post(`/api/admin/impersonate/${targetUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
    const impersonationToken = impersonationRes.body.accessToken

    // Try to use impersonation token to access admin endpoint
    await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${impersonationToken}`)
      .expect(403)
  })

  test('impersonation token cannot request another impersonation token', async () => {
    // Get first impersonation token
    const impersonationRes = await request(app)
      .post(`/api/admin/impersonate/${targetUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
    const impersonationToken = impersonationRes.body.accessToken

    // Try to use it to get another impersonation token
    await request(app)
      .post(`/api/admin/impersonate/some-other-user`)
      .set('Authorization', `Bearer ${impersonationToken}`)
      .expect(403)
  })

  test('returns 404 for non-existent user', async () => {
    await request(app)
      .post('/api/admin/impersonate/non-existent-id')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404)
  })

  test('requires authentication', async () => {
    await request(app)
      .post(`/api/admin/impersonate/${targetUserId}`)
      .expect(401)
  })
})

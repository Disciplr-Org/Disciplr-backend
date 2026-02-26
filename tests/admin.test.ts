import request from 'supertest'
import { app } from '../app.js'
import { db } from '../db/index.js'
import { UserRole, UserStatus } from '../types/user.js'
import { generateAccessToken } from '../lib/auth-utils.js'

describe('Admin User Management API', () => {
  let adminToken: string
  let userToken: string
  let verifierToken: string
  let testUsers: any[] = []

  beforeAll(async () => {
    // Clean up any existing test data
    await db('users').where('email', 'like', '%test%').del()

    // Create test users
    const adminUser = {
      id: 'admin-test-id',
      email: 'admin-test@example.com',
      passwordHash: 'hashed-password',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const regularUser = {
      id: 'user-test-id',
      email: 'user-test@example.com',
      passwordHash: 'hashed-password',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const verifierUser = {
      id: 'verifier-test-id',
      email: 'verifier-test@example.com',
      passwordHash: 'hashed-password',
      role: UserRole.VERIFIER,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    await db('users').insert([adminUser, regularUser, verifierUser])
    testUsers = [adminUser, regularUser, verifierUser]

    // Generate JWT tokens
    adminToken = generateAccessToken({ userId: adminUser.id, role: UserRole.ADMIN })
    userToken = generateAccessToken({ userId: regularUser.id, role: UserRole.USER })
    verifierToken = generateAccessToken({ userId: verifierUser.id, role: UserRole.VERIFIER })
  })

  afterAll(async () => {
    // Clean up test data
    await db('users').where('email', 'like', '%test%').del()
    await db.destroy()
  })

  describe('Authentication & Authorization', () => {
    test('should deny access without authentication', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .expect(401)

      expect(response.body).toHaveProperty('error', 'Unauthorized: Missing or invalid token')
    })

    test('should deny access to non-admin users', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403)

      expect(response.body).toHaveProperty('error', 'Forbidden: Insufficient permissions')
    })

    test('should deny access to verifier users', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${verifierToken}`)
        .expect(403)

      expect(response.body).toHaveProperty('error', 'Forbidden: Insufficient permissions')
    })

    test('should allow access to admin users', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body).toHaveProperty('data')
      expect(response.body).toHaveProperty('pagination')
    })
  })

  describe('GET /api/admin/users', () => {
    test('should return paginated users list', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body).toHaveProperty('data')
      expect(response.body).toHaveProperty('pagination')
      expect(response.body.pagination).toHaveProperty('limit')
      expect(response.body.pagination).toHaveProperty('offset')
      expect(response.body.pagination).toHaveProperty('total')
      expect(response.body.pagination).toHaveProperty('hasMore')
      expect(Array.isArray(response.body.data)).toBe(true)
    })

    test('should filter users by role', async () => {
      const response = await request(app)
        .get('/api/admin/users?role=USER')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.data.every((user: any) => user.role === 'USER')).toBe(true)
    })

    test('should filter users by status', async () => {
      const response = await request(app)
        .get('/api/admin/users?status=ACTIVE')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.data.every((user: any) => user.status === 'ACTIVE')).toBe(true)
    })

    test('should search users by email', async () => {
      const response = await request(app)
        .get('/api/admin/users?search=admin-test')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.data.some((user: any) => user.email.includes('admin-test'))).toBe(true)
    })

    test('should reject invalid role filter', async () => {
      const response = await request(app)
        .get('/api/admin/users?role=INVALID')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Invalid role value')
    })

    test('should reject invalid status filter', async () => {
      const response = await request(app)
        .get('/api/admin/users?status=INVALID')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Invalid status value')
    })

    test('should respect pagination limits', async () => {
      const response = await request(app)
        .get('/api/admin/users?limit=1&offset=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.data).toHaveLength(1)
      expect(response.body.pagination.limit).toBe(1)
      expect(response.body.pagination.offset).toBe(0)
    })
  })

  describe('PATCH /api/admin/users/:id/role', () => {
    test('should update user role successfully', async () => {
      const targetUserId = testUsers[1].id // regular user
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.VERIFIER })
        .expect(200)

      expect(response.body).toHaveProperty('user')
      expect(response.body).toHaveProperty('auditLogId')
      expect(response.body.user.role).toBe(UserRole.VERIFIER)
    })

    test('should create audit log for role update', async () => {
      const targetUserId = testUsers[1].id
      await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.USER })
        .expect(200)

      // Check audit log was created
      const auditResponse = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const roleUpdateLog = auditResponse.body.audit_logs.find((log: any) => 
        log.action === 'user.role.update' && 
        log.target_id === targetUserId
      )

      expect(roleUpdateLog).toBeDefined()
      expect(roleUpdateLog.metadata).toHaveProperty('old_role')
      expect(roleUpdateLog.metadata).toHaveProperty('new_role')
      expect(roleUpdateLog.metadata).toHaveProperty('admin_id')
    })

    test('should reject invalid role', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'INVALID_ROLE' })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Invalid role. Must be one of: USER, VERIFIER, ADMIN')
    })

    test('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .patch('/api/admin/users/non-existent-id/role')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.VERIFIER })
        .expect(404)

      expect(response.body).toHaveProperty('error', 'User not found')
    })

    test('should reject role update to same role', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.USER })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'User already has this role')
    })
  })

  describe('PATCH /api/admin/users/:id/status', () => {
    test('should update user status successfully', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: UserStatus.SUSPENDED })
        .expect(200)

      expect(response.body).toHaveProperty('user')
      expect(response.body).toHaveProperty('auditLogId')
      expect(response.body.user.status).toBe(UserStatus.SUSPENDED)
    })

    test('should create audit log for status update', async () => {
      const targetUserId = testUsers[1].id
      await request(app)
        .patch(`/api/admin/users/${targetUserId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: UserStatus.ACTIVE })
        .expect(200)

      // Check audit log was created
      const auditResponse = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const statusUpdateLog = auditResponse.body.audit_logs.find((log: any) => 
        log.action === 'user.status.update' && 
        log.target_id === targetUserId
      )

      expect(statusUpdateLog).toBeDefined()
      expect(statusUpdateLog.metadata).toHaveProperty('old_status')
      expect(statusUpdateLog.metadata).toHaveProperty('new_status')
      expect(statusUpdateLog.metadata).toHaveProperty('admin_id')
    })

    test('should reject invalid status', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'INVALID_STATUS' })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Invalid status. Must be one of: ACTIVE, INACTIVE, SUSPENDED')
    })

    test('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .patch('/api/admin/users/non-existent-id/status')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: UserStatus.SUSPENDED })
        .expect(404)

      expect(response.body).toHaveProperty('error', 'User not found')
    })

    test('should reject status update to same status', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: UserStatus.ACTIVE })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'User already has this status')
    })
  })

  describe('Audit Logs Integration', () => {
    test('should include user management actions in audit logs', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const userActions = response.body.audit_logs.filter((log: any) => 
        log.action === 'user.role.update' || log.action === 'user.status.update'
      )

      expect(userActions.length).toBeGreaterThan(0)
    })

    test('should filter audit logs by action', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?action=user.role.update')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.audit_logs.every((log: any) => log.action === 'user.role.update')).toBe(true)
    })
  })
})

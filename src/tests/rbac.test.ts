import { describe, it, beforeAll } from '@jest/globals'
import request from 'supertest'
import express from 'express'
import { authenticate, signToken } from '../middleware/auth.js'
import { requireUser, requireVerifier, requireAdmin } from '../middleware/rbac.js'
import { UserRole } from '@prisma/client'
import { jest } from '@jest/globals'

// Mock database connection
const mockDb = {
  insert: jest.fn<any>().mockReturnThis(),
  returning: jest.fn<any>().mockReturnThis(),
  where: jest.fn<any>().mockReturnThis(),
  whereNull: jest.fn<any>().mockReturnThis(),
  andWhere: jest.fn<any>().mockReturnThis(),
  update: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>().mockResolvedValue({ id: 'mock-session-id' }),
}

jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn<any>(() => mockDb),
}))

let app: express.Express
let tokenHelpers: Record<string, () => Promise<string>>

beforeAll(async () => {
    // Dynamic import to allow mocks to be applied before module evaluation
    const authModule = await import('../middleware/auth.js')
    const rbacModule = await import('../middleware/rbac.js')

    app = express()
    app.use(express.json())

    app.get('/user-route', authModule.authenticate, rbacModule.requireUser, (_req, res) => res.json({ ok: true }))
    app.post('/verify-route', authModule.authenticate, rbacModule.requireVerifier, (_req, res) => res.json({ ok: true }))
    app.delete('/admin-route', authModule.authenticate, rbacModule.requireAdmin, (_req, res) => res.json({ ok: true }))

    tokenHelpers = {
        user: async () => `Bearer ${await authModule.signToken({ userId: '1', role: UserRole.USER })}`,
        verifier: async () => `Bearer ${await authModule.signToken({ userId: '1', role: UserRole.VERIFIER })}`,
        admin: async () => `Bearer ${await authModule.signToken({ userId: '1', role: UserRole.ADMIN })}`,
    }
})

describe('authenticate', () => {
     it('rejects request with no token', async () => {
          const res = await request(app).get('/user-route')
          expect(res.status).toBe(401)
     })

     it('rejects an invalid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', 'Bearer invalid-token')
          expect(res.status).toBe(401)
     })

     it('accepts a valid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await tokenHelpers.user())
          expect(res.status).toBe(200)
     })
})

describe('requireUser', () => {
     it('allows user', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await tokenHelpers.user())
          expect(res.status).toBe(200)
     })

     it('allows verifier', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await tokenHelpers.verifier())
          expect(res.status).toBe(200)
     })

     it('allows admin', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await tokenHelpers.admin())
          expect(res.status).toBe(200)
     })
})

describe('requireVerifier', () => {
     it('forbids user', async () => {
          const res = await request(app).post('/verify-route').set('Authorization', await tokenHelpers.user())
          expect(res.status).toBe(403)
     })

     it('allows verifier', async () => {
          const res = await request(app).post('/verify-route').set('Authorization', await tokenHelpers.verifier())
          expect(res.status).toBe(200)
     })

     it('allows admin', async () => {
          const res = await request(app).post('/verify-route').set('Authorization', await tokenHelpers.admin())
          expect(res.status).toBe(200)
     })
})

describe('requireAdmin', () => {
     it('forbids user', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await tokenHelpers.user())
          expect(res.status).toBe(403)
     })

     it('forbids verifier', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await tokenHelpers.verifier())
          expect(res.status).toBe(403)
     })

     it('allows admin', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await tokenHelpers.admin())
          expect(res.status).toBe(200)
     })
})
import request from 'supertest'
import express from 'express'
import { beforeAll, describe, it, expect, jest } from '@jest/globals'

// Mock database and helpers
const mockDb = {
  insert: jest.fn<any>().mockReturnThis(),
  returning: jest.fn<any>().mockReturnThis(),
  where: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>().mockResolvedValue({}),
  select: jest.fn<any>().mockReturnThis(),
}

// Mock the services before they are imported by middlewares
jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn<any>(() => mockDb),
}))

let requireOrgRole: any, requireTeamRole: any
const app = express()
app.use(express.json())

beforeAll(async () => {
    // We use dynamic imports to ensure mocks are applied
    const orgAuthModule = await import('../middleware/orgAuth.js')
    requireOrgRole = orgAuthModule.requireOrgRole
    requireTeamRole = orgAuthModule.requireTeamRole

    // Setup routes after middlewares are loaded
    app.get('/org/:orgId/admin', (req, res, next) => {
      (req as any).user = { sub: 'user-1', role: 'user' }
      next()
    }, requireOrgRole(['admin']), (req, res) => res.json({ ok: true }))

    app.get('/team/:teamId/member', (req, res, next) => {
      (req as any).user = { sub: 'user-2', role: 'user' }
      next()
    }, requireTeamRole(['member', 'lead']), (req, res) => res.json({ ok: true }))
})

describe('Enterprise Hierarchy & RBAC', () => {
  it('should allow access with correct organization role', async () => {
    mockDb.first.mockResolvedValueOnce({ role: 'admin' })
    
    const res = await request(app).get('/org/org-1/admin')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('should deny access with incorrect organization role', async () => {
    mockDb.first.mockResolvedValueOnce({ role: 'member' })
    
    const res = await request(app).get('/org/org-1/admin')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/requires organization role admin/)
  })

  it('should allow access with correct team role', async () => {
    mockDb.first.mockResolvedValueOnce({ role: 'member' })
    
    const res = await request(app).get('/team/team-1/member')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('should deny access with incorrect team role', async () => {
    mockDb.first.mockResolvedValueOnce(null)
    
    const res = await request(app).get('/team/team-1/member')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/requires team role member or lead/)
  })
})

import request from 'supertest'
import express from 'express'
import { beforeAll, describe, it, expect, jest } from '@jest/globals'

// Mock database and helpers
const mockDb = {
  insert: jest.fn<any>().mockReturnThis(),
  returning: jest.fn<any>().mockReturnThis(),
  where: jest.fn<any>().mockReturnThis(),
  orderBy: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>().mockResolvedValue({}),
  select: jest.fn<any>().mockReturnThis(),
  update: jest.fn<any>().mockReturnThis(),
}

// Mock database connection
jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn<any>(() => mockDb),
}))

// Mock SessionService to allow authenticate middleware to work
jest.unstable_mockModule('../services/session.js', () => ({
  validateSession: jest.fn<any>().mockResolvedValue(true),
  recordSession: jest.fn<any>().mockResolvedValue(undefined),
  revokeSession: jest.fn<any>().mockResolvedValue(undefined),
  revokeAllUserSessions: jest.fn<any>().mockResolvedValue(undefined),
  forceRevokeUserSessions: jest.fn<any>().mockResolvedValue(undefined),
}))

let app: express.Express
let signToken: any

beforeAll(async () => {
    const authModule = await import('../middleware/auth.js')
    const appModule = await import('../app.js')
    
    app = appModule.app
    signToken = authModule.signToken
})

describe('Notifications API', () => {
  it('should list user notifications', async () => {
    const userId = 'user-1'
    const token = await signToken({ sub: userId, role: 'user' })
    
    mockDb.select.mockResolvedValueOnce([
      { id: '1', user_id: userId, title: 'Test', message: 'Hello', read_at: null }
    ])
    
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`)
    
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body[0].title).toBe('Test')
  })

  it('should mark a notification as read', async () => {
    const userId = 'user-2'
    const token = await signToken({ sub: userId, role: 'user' })
    const notificationId = 'notif-1'
    
    mockDb.returning.mockResolvedValueOnce([{ id: notificationId, read_at: new Date().toISOString() }])
    
    const res = await request(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${token}`)
    
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(notificationId)
    expect(res.body.read_at).not.toBeNull()
  })

  it('should mark all notifications as read', async () => {
    const userId = 'user-3'
    const token = await signToken({ sub: userId, role: 'user' })
    
    mockDb.update.mockResolvedValueOnce(5) // 5 notifications updated
    
    const res = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${token}`)
    
    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(/Marked 5 notifications as read/)
  })

  it('should fail unauthenticated requests', async () => {
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(401)
  })
})

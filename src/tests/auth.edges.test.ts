import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import request from 'supertest'
import express from 'express'
import { UserRole } from '../types/user.js'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'

// Mock dependencies
const mockPrisma = {
  user: {
    findUnique: jest.fn<any>(),
    update: jest.fn<any>(),
    create: jest.fn<any>(),
  },
  refreshToken: {
    create: jest.fn<any>(),
    findUnique: jest.fn<any>(),
    update: jest.fn<any>(),
    updateMany: jest.fn<any>(),
  },
}

const mockDb = jest.fn(() => ({
  insert: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  whereNull: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  first: jest.fn(),
}))

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: mockPrisma,
}))

// Mock both default and named exports for db/index.js
jest.unstable_mockModule('../db/index.js', () => ({
  default: mockDb,
  db: mockDb,
}))

// Mock auth-utils for refresh token verification
const mockAuthUtils = {
  verifyRefreshToken: jest.fn<any>(),
  generateAccessToken: jest.fn<any>(),
  generateRefreshToken: jest.fn<any>(),
}
jest.unstable_mockModule('../lib/auth-utils.js', () => mockAuthUtils)

let app: express.Express
let AuthService: any
let authenticate: any

beforeEach(async () => {
  jest.clearAllMocks()
  
  // Dynamic imports to ensure mocks are applied
  const authServiceModule = await import('../services/auth.service.js')
  AuthService = authServiceModule.AuthService
  const authMiddlewareModule = await import('../middleware/auth.js')
  authenticate = authMiddlewareModule.authenticate

  app = express()
  app.use(express.json())
  
  // A protected route using the middleware we want to test
  app.get('/api/protected', authenticate, (req, res) => {
    res.json({ ok: true, user: req.user })
  })
})

describe('Auth Session Expiry Edge Cases', () => {
  const SECRET = process.env.JWT_SECRET || 'change-me-in-production'
  const userId = 'user-123'
  const role = UserRole.USER

  describe('Access Token Expiry & Validation', () => {
    it('should allow valid token with active session', async () => {
      const jti = randomUUID()
      const token = jwt.sign({ userId, role, jti }, SECRET, { expiresIn: '15m' })
      
      // Mock session validation
      ;(mockDb() as any).first.mockResolvedValueOnce({ jti, expires_at: new Date(Date.now() + 100000).toISOString() })

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.user.userId).toBe(userId)
    })

    it('should reject expired access token (JWT level)', async () => {
      const token = jwt.sign({ userId, role }, SECRET, { expiresIn: '-1s' })

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Token expired')
    })

    it('should reject token if session is revoked in DB', async () => {
      const jti = randomUUID()
      const token = jwt.sign({ userId, role, jti }, SECRET, { expiresIn: '15m' })
      
      // Mock session validation showing it's either revoked or expired in DB
      ;(mockDb() as any).first.mockResolvedValueOnce(null)

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Session revoked or expired')
    })
  })

  describe('Clock Skew Tolerance', () => {
    it('should allow token with minor iat/nbf skew (iat in future)', async () => {
      const jti = randomUUID()
      // iat 10 seconds in the future
      const iat = Math.floor(Date.now() / 1000) + 10
      const token = jwt.sign({ userId, role, jti, iat }, SECRET)
      
      ;(mockDb() as any).first.mockResolvedValueOnce({ jti })

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      // Should be 200 because we added clockTolerance: 30
      expect(res.status).toBe(200)
    })

    it('should reject token with excessive future skew', async () => {
      const jti = randomUUID()
      // iat 1 hour in the future
      const iat = Math.floor(Date.now() / 1000) + 3600
      const token = jwt.sign({ userId, role, jti, iat }, SECRET)

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Invalid token')
    })
  })

  describe('Refresh Token behavior', () => {
    it('should fail if refresh token is expired in DB', async () => {
      mockAuthUtils.verifyRefreshToken.mockReturnValueOnce({ userId })
      mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
        id: 'token-1',
        token: 'refresh-token',
        expiresAt: new Date(Date.now() - 1000), // Expired
        revokedAt: null,
      })

      await expect(AuthService.refresh('refresh-token')).rejects.toThrow('Invalid refresh token')
    })

    it('should fail if refresh token is already revoked', async () => {
      mockAuthUtils.verifyRefreshToken.mockReturnValueOnce({ userId })
      mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
        id: 'token-1',
        token: 'refresh-token',
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: new Date(), // Revoked
      })

      await expect(AuthService.refresh('refresh-token')).rejects.toThrow('Invalid refresh token')
    })
  })
})

//
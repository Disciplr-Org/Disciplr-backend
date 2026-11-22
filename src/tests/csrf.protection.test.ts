// Register ESM mocks before dynamically importing the middleware under test.
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'

jest.unstable_mockModule('../lib/auth-utils.js', () => ({
  verifyAccessToken: jest.fn(),
  getJwtSecret: jest.fn().mockReturnValue('test-secret'),
}))

jest.unstable_mockModule('../config/index.js', () => ({
  config: { corsOrigins: ['https://app.example.com'] },
}))

const { csrfProtection } = await import('../middleware/auth.js')
const { verifyAccessToken } = await import('../lib/auth-utils.js')
const mockedVerifyAccessToken = jest.mocked(verifyAccessToken)

describe('csrfProtection', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    jest.clearAllMocks()
    req = {
      method: 'POST',
      headers: {},
    }
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    next = jest.fn<NextFunction>()
  })

  describe('Bearer token exemption', () => {
    it('exempts verifiable JWT bearer tokens from CSRF checks', () => {
      req.headers = {
        authorization: 'Bearer valid.jwt.token',
      }
      mockedVerifyAccessToken.mockReturnValue({ userId: 'u1', role: 'USER' })

      csrfProtection(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(res.status).not.toHaveBeenCalled()
    })

    it('falls through to CSRF origin check when Bearer token is unverifiable (e.g. user:<id>)', () => {
      req.headers = {
        authorization: 'Bearer user:12345',
        origin: 'https://evil.com',
      }
      mockedVerifyAccessToken.mockImplementation(() => {
        throw new Error('invalid token')
      })

      csrfProtection(req as Request, res as Response, next)

      // Should NOT call next() — the unverifiable token does NOT grant CSRF exemption
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    })

    it('falls through to CSRF origin check when Bearer token fails legacy jwt.verify', () => {
      req.headers = {
        authorization: 'Bearer not-a-jwt',
        origin: 'https://evil.com',
      }
      mockedVerifyAccessToken.mockImplementation(() => {
        throw new Error('invalid token')
      })

      csrfProtection(req as Request, res as Response, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(403)
    })

    it('allows the request when unverifiable Bearer token comes from allowed origin', () => {
      req.headers = {
        authorization: 'Bearer user:12345',
        origin: 'https://app.example.com',
      }
      mockedVerifyAccessToken.mockImplementation(() => {
        throw new Error('invalid token')
      })

      csrfProtection(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(res.status).not.toHaveBeenCalled()
    })
  })

  describe('Origin / Referer validation', () => {
    it('blocks requests from disallowed origins on state-changing methods', () => {
      req.headers = { origin: 'https://evil.com' }

      csrfProtection(req as Request, res as Response, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(403)
    })

    it('allows requests from allowed origins', () => {
      req.headers = { origin: 'https://app.example.com' }

      csrfProtection(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledTimes(1)
    })

    it('allows requests with no origin or referer', () => {
      req.headers = {}

      csrfProtection(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledTimes(1)
    })
  })

  describe('Safe methods', () => {
    it('always allows GET requests without any checks', () => {
      req.method = 'GET'
      req.headers = { origin: 'https://evil.com' }

      csrfProtection(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(res.status).not.toHaveBeenCalled()
    })
  })
})
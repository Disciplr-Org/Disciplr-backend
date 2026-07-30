import { describe, it, expect, vi, beforeEach } from 'vitest'
import { csrfProtection } from '../../src/middleware/auth.js'
import type { Request, Response, NextFunction } from 'express'

vi.mock('../../src/lib/auth-utils.js', () => ({
  verifyAccessToken: vi.fn(),
  getJwtSecret: vi.fn().mockReturnValue('test-secret'),
}))

vi.mock('../../src/config/index.js', () => ({
  config: { corsOrigins: ['https://app.example.com'] },
}))

import { verifyAccessToken } from '../../src/lib/auth-utils.js'
const mockedVerifyAccessToken = vi.mocked(verifyAccessToken)

describe('csrfProtection', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction

  beforeEach(() => {
    vi.clearAllMocks()
    req = {
      method: 'POST',
      headers: {},
    }
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
    next = vi.fn()
  })

  describe('Bearer token exemption', () => {
    it('exempts verifiable JWT bearer tokens from CSRF checks', () => {
      req.headers = {
        authorization: 'Bearer valid.jwt.token',
      }
      mockedVerifyAccessToken.mockReturnValue({ userId: 'u1', role: 'USER' } as any)

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
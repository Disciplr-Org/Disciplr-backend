import { jest, describe, it, expect, beforeEach, mock } from 'bun:test'

const mockGetEnv = jest.fn()
mock.module('../config/env.js', () => ({
  getEnv: mockGetEnv
}))

const { metricsAuth, _test } = await import('../middleware/metricsAuth.js')

describe('metricsAuth middleware', () => {
  let req: any
  let res: any
  let next: any
  let consoleSpy: any

  beforeEach(() => {
    req = {
      ip: '192.168.1.100',
      socket: { remoteAddress: '192.168.1.100' },
      headers: {}
    }
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    }
    next = jest.fn()
    
    mockGetEnv.mockReturnValue({
      METRICS_TOKEN: undefined,
      METRICS_ALLOWLIST: undefined
    })

    _test.resetThrottle()
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('IP Allowlist Enforcement', () => {
    it('allows access if IP matches exact allowlist entry', () => {
      mockGetEnv.mockReturnValue({ METRICS_ALLOWLIST: '192.168.1.100, 10.0.0.1' })
      metricsAuth(req, res, next)
      
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"allowed":true'))
    })

    it('allows access if IP matches CIDR allowlist entry', () => {
      mockGetEnv.mockReturnValue({ METRICS_ALLOWLIST: '192.168.1.0/24' })
      req.ip = '192.168.1.150'
      metricsAuth(req, res, next)
      
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('denies access if IP is not in allowlist and no token configured', () => {
      mockGetEnv.mockReturnValue({ METRICS_ALLOWLIST: '10.0.0.0/8' })
      metricsAuth(req, res, next)
      
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: access denied' })
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"allowed":false'))
    })
  })

  describe('Bearer Token Enforcement', () => {
    beforeEach(() => {
      mockGetEnv.mockReturnValue({ METRICS_TOKEN: 'secret-token' })
    })

    it('allows access with valid bearer token', () => {
      req.headers.authorization = 'Bearer secret-token'
      metricsAuth(req, res, next)
      
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('denies access with invalid bearer token', () => {
      req.headers.authorization = 'Bearer wrong-token'
      metricsAuth(req, res, next)
      
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: invalid metrics token' })
    })

    it('denies access when token is required but missing', () => {
      metricsAuth(req, res, next)
      
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: metrics token required' })
    })
  })

  describe('Combined enforcement', () => {
    it('allows access if token is missing but IP is allowlisted', () => {
      mockGetEnv.mockReturnValue({ 
        METRICS_TOKEN: 'secret-token',
        METRICS_ALLOWLIST: '192.168.1.0/24'
      })
      
      metricsAuth(req, res, next)
      
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })
  })
})

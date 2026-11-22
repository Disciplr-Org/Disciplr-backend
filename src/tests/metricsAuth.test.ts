// Jest ESM port of the original bun:test suite.
//
// The env module is mocked with jest.unstable_mockModule() BEFORE the
// dynamic import below: the mock must be registered first, otherwise the
// real ../config/env.js loads and getEnv() throws. Only cases not already
// covered by metrics.access.test.ts are kept here (IPv6 CIDR, audit-log
// lines, and token-configured + allowlisted IP).
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'

const mockGetEnv = jest.fn<any>()

jest.unstable_mockModule('../config/env.js', () => ({
  getEnv: mockGetEnv,
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
      headers: {},
    }
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }
    next = jest.fn()

    mockGetEnv.mockReturnValue({
      METRICS_TOKEN: undefined,
      METRICS_ALLOWLIST: undefined,
    })

    _test.resetThrottle()
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('IP Allowlist Enforcement', () => {
    it('allows access if IP matches exact allowlist entry', () => {
      mockGetEnv.mockReturnValue({ METRICS_ALLOWLIST: '192.168.1.100, 10.0.0.1' })
      metricsAuth(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"allowed":true'))
    })

    it('allows a native IPv6 client inside an IPv6 CIDR range', () => {
      mockGetEnv.mockReturnValue({ METRICS_ALLOWLIST: '2001:db8:1234::/48' })
      req.ip = '2001:db8:1234::42'

      metricsAuth(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(_test.matchesCidr(req.ip, '2001:db8:1234::/48')).toBe(true)
    })

    it('denies a native IPv6 client outside the configured range', () => {
      mockGetEnv.mockReturnValue({ METRICS_ALLOWLIST: '2001:db8:1234::/48' })
      req.ip = '2001:db8:5678::42'

      metricsAuth(req, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(_test.matchesCidr(req.ip, '2001:db8:1234::/48')).toBe(false)
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

  describe('Combined enforcement', () => {
    it('allows access if token is missing but IP is allowlisted', () => {
      mockGetEnv.mockReturnValue({
        METRICS_TOKEN: 'secret-token',
        METRICS_ALLOWLIST: '192.168.1.0/24',
      })

      metricsAuth(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })
  })
})

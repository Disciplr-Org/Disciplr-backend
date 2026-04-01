/**
 * @file helmet.test.ts
 * Tests for helmet CSP and security header configuration (Issue #131).
 *
 * Strategy: spin up the Express app in-process via supertest so we exercise
 * the real middleware stack without a live server. Each test hits GET /
 * (returns 404 — that's fine; headers are set before routing) and asserts
 * the response headers match the API-only helmet policy.
 */

import request from 'supertest'
import { app } from '../app.js'

describe('helmet security headers (Issue #131)', () => {
  // -------------------------------------------------------------------------
  // Content-Security-Policy
  // -------------------------------------------------------------------------
  describe('Content-Security-Policy', () => {
    it('sets default-src to none', async () => {
      const res = await request(app).get('/')
      const csp = res.headers['content-security-policy'] as string
      expect(csp).toBeDefined()
      expect(csp).toContain("default-src 'none'")
    })

    it('sets frame-ancestors to none', async () => {
      const res = await request(app).get('/')
      const csp = res.headers['content-security-policy'] as string
      expect(csp).toContain("frame-ancestors 'none'")
    })

    it('sets script-src to none', async () => {
      const res = await request(app).get('/')
      const csp = res.headers['content-security-policy'] as string
      expect(csp).toContain("script-src 'none'")
    })

    it('sets form-action to none', async () => {
      const res = await request(app).get('/')
      const csp = res.headers['content-security-policy'] as string
      expect(csp).toContain("form-action 'none'")
    })

    it('sets object-src to none', async () => {
      const res = await request(app).get('/')
      const csp = res.headers['content-security-policy'] as string
      expect(csp).toContain("object-src 'none'")
    })
  })

  // -------------------------------------------------------------------------
  // Strict-Transport-Security
  // -------------------------------------------------------------------------
  describe('Strict-Transport-Security', () => {
    it('sets max-age to at least 31536000 (1 year)', async () => {
      const res = await request(app).get('/')
      const hsts = res.headers['strict-transport-security'] as string
      expect(hsts).toBeDefined()
      const match = hsts.match(/max-age=(\d+)/)
      expect(match).not.toBeNull()
      const maxAge = parseInt(match![1], 10)
      expect(maxAge).toBeGreaterThanOrEqual(31_536_000)
    })

    it('includes includeSubDomains', async () => {
      const res = await request(app).get('/')
      const hsts = res.headers['strict-transport-security'] as string
      expect(hsts.toLowerCase()).toContain('includesubdomains')
    })

    it('does not include preload (not yet registered in preload list)', async () => {
      const res = await request(app).get('/')
      const hsts = res.headers['strict-transport-security'] as string
      expect(hsts.toLowerCase()).not.toContain('preload')
    })
  })

  // -------------------------------------------------------------------------
  // X-Frame-Options — must be absent (CSP frame-ancestors supersedes it)
  // -------------------------------------------------------------------------
  describe('X-Frame-Options', () => {
    it('is not set (superseded by CSP frame-ancestors)', async () => {
      const res = await request(app).get('/')
      expect(res.headers['x-frame-options']).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // X-Powered-By — must be absent
  // -------------------------------------------------------------------------
  describe('X-Powered-By', () => {
    it('is removed by helmet', async () => {
      const res = await request(app).get('/')
      expect(res.headers['x-powered-by']).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // X-Content-Type-Options
  // -------------------------------------------------------------------------
  describe('X-Content-Type-Options', () => {
    it('is set to nosniff', async () => {
      const res = await request(app).get('/')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    })
  })

  // -------------------------------------------------------------------------
  // Referrer-Policy
  // -------------------------------------------------------------------------
  describe('Referrer-Policy', () => {
    it('is set to no-referrer', async () => {
      const res = await request(app).get('/')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    })
  })

  // -------------------------------------------------------------------------
  // Cross-Origin-Resource-Policy
  // -------------------------------------------------------------------------
  describe('Cross-Origin-Resource-Policy', () => {
    it('is set to same-site', async () => {
      const res = await request(app).get('/')
      expect(res.headers['cross-origin-resource-policy']).toBe('same-site')
    })
  })

  // -------------------------------------------------------------------------
  // Cross-Origin-Opener-Policy
  // -------------------------------------------------------------------------
  describe('Cross-Origin-Opener-Policy', () => {
    it('is set to same-origin', async () => {
      const res = await request(app).get('/')
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    })
  })

  // -------------------------------------------------------------------------
  // X-DNS-Prefetch-Control
  // -------------------------------------------------------------------------
  describe('X-DNS-Prefetch-Control', () => {
    it('is set to off', async () => {
      const res = await request(app).get('/')
      expect(res.headers['x-dns-prefetch-control']).toBe('off')
    })
  })

  // -------------------------------------------------------------------------
  // X-Permitted-Cross-Domain-Policies
  // -------------------------------------------------------------------------
  describe('X-Permitted-Cross-Domain-Policies', () => {
    it('is set to none', async () => {
      const res = await request(app).get('/')
      expect(res.headers['x-permitted-cross-domain-policies']).toBe('none')
    })
  })

  // -------------------------------------------------------------------------
  // Custom header: X-Timezone (non-helmet, regression guard)
  // -------------------------------------------------------------------------
  describe('X-Timezone', () => {
    it('is set to UTC by app middleware', async () => {
      const res = await request(app).get('/')
      expect(res.headers['x-timezone']).toBe('UTC')
    })
  })
})
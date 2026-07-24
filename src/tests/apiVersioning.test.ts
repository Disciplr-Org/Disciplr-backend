import { jest } from '@jest/globals'
import express, { type Request, type Response } from 'express'
import { mountVersionedRoute } from '../middleware/versioning.js'
import { LEGACY_SUNSET_HTTP_DATE, VERSIONED_PREFIX } from '../config/versions.js'

const request = (await import('supertest')).default

describe('API Versioning & Deprecation Headers', () => {
  let app: express.Application

  beforeEach(() => {
    app = express()
    app.use(express.json())

    // Mount a dummy route under both legacy and versioned paths
    mountVersionedRoute(
      app,
      '/api/health',
      `${VERSIONED_PREFIX}/health`,
      (_req: Request, res: Response) => {
        res.json({ status: 'ok', version: 'v1' })
      },
    )

    // Mount a second route to prove the pattern generalises
    mountVersionedRoute(
      app,
      '/api/vaults',
      `${VERSIONED_PREFIX}/vaults`,
      (_req: Request, res: Response) => {
        res.json({ data: [] })
      },
    )

    // 404 handler
    app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' })
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Versioned routes (canonical)
  // ──────────────────────────────────────────────────────────────────────────

  describe('Versioned routes', () => {
    it('should respond on /api/v1/health without deprecation headers', async () => {
      const res = await request(app).get('/api/v1/health')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ status: 'ok', version: 'v1' })
      expect(res.headers['deprecation']).toBeUndefined()
      expect(res.headers['sunset']).toBeUndefined()
      expect(res.headers['link']).toBeUndefined()
    })

    it('should respond on /api/v1/vaults without deprecation headers', async () => {
      const res = await request(app).get('/api/v1/vaults')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ data: [] })
      expect(res.headers['deprecation']).toBeUndefined()
      expect(res.headers['sunset']).toBeUndefined()
      expect(res.headers['link']).toBeUndefined()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Legacy routes (deprecated aliases)
  // ──────────────────────────────────────────────────────────────────────────

  describe('Legacy routes', () => {
    it('should respond on /api/health with deprecation headers', async () => {
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ status: 'ok', version: 'v1' })
      expect(res.headers['deprecation']).toBe('true')
      expect(res.headers['sunset']).toBe(LEGACY_SUNSET_HTTP_DATE)
      expect(res.headers['link']).toBe('</api/v1/health>; rel="successor-version"')
    })

    it('should respond on /api/vaults with deprecation headers', async () => {
      const res = await request(app).get('/api/vaults')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ data: [] })
      expect(res.headers['deprecation']).toBe('true')
      expect(res.headers['sunset']).toBe(LEGACY_SUNSET_HTTP_DATE)
      expect(res.headers['link']).toBe('</api/v1/vaults>; rel="successor-version"')
    })

    it('should return 404 on unknown legacy paths without deprecation headers', async () => {
      const res = await request(app).get('/api/unknown')
      expect(res.status).toBe(404)
      // Deprecation middleware is only mounted on known legacy routes,
      // so a 404 catch-all should not have these headers.
      expect(res.headers['deprecation']).toBeUndefined()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Response parity
  // ──────────────────────────────────────────────────────────────────────────

  describe('Response parity', () => {
    it('should return identical bodies for legacy and versioned health', async () => {
      const legacy = await request(app).get('/api/health')
      const versioned = await request(app).get('/api/v1/health')
      expect(legacy.body).toEqual(versioned.body)
    })

    it('should return identical bodies for legacy and versioned vaults', async () => {
      const legacy = await request(app).get('/api/vaults')
      const versioned = await request(app).get('/api/v1/vaults')
      expect(legacy.body).toEqual(versioned.body)
    })
  })
})


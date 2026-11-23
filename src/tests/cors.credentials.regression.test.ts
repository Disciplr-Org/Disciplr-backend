import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import request from 'supertest'
import express from 'express'
import cors, { CorsOptions } from 'cors'
import { config } from '../config/index.js'

describe('CORS credentials regression test (#1051)', () => {
  let originalCorsOrigins: string | undefined

  beforeEach(() => {
    originalCorsOrigins = process.env.CORS_ORIGINS
  })

  afterEach(() => {
    if (originalCorsOrigins !== undefined) {
      process.env.CORS_ORIGINS = originalCorsOrigins
    } else {
      delete process.env.CORS_ORIGINS
    }
  })

  function createTestApp() {
    // Recreate CORS options dynamically based on current env vars
    const currentCorsOrigins = config.corsOrigins
    const isWildcard = currentCorsOrigins === "*"

    const corsOptions: CorsOptions = {
      origin: (origin, callback) => {
        // Block 'null' origin (untrusted)
        if (origin === "null") {
          console.log(
            JSON.stringify({
              level: "warn",
              event: "security.cors_rejected",
              service: config.serviceName,
              origin,
              timestamp: new Date().toISOString(),
            }),
          );
          callback(null, false);
          return;
        }

        // Allow server-to-server requests (no Origin header)
        if (!origin) {
          callback(null, true);
          return;
        }

        // Wildcard: allow all origins, echo request origin
        if (isWildcard) {
          callback(null, true);
          return;
        }

        // Check allowlist
        const allowedOrigins = currentCorsOrigins as string[]
        const normalizedOrigin = origin.replace(/\/+$/, '')
        if (allowedOrigins.includes(normalizedOrigin)) {
          callback(null, true);
        } else {
          console.log(
            JSON.stringify({
              level: "warn",
              event: "security.cors_rejected",
              service: config.serviceName,
              origin,
              timestamp: new Date().toISOString(),
            }),
          );
          callback(null, false);
        }
      },
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      allowedHeaders: ["Content-Type", "Authorization", "idempotency-key"],
      credentials: isWildcard ? false : true,
    };

    const app = express()
    app.use(cors(corsOptions))
    app.get('/api/test', (_req, res) => {
      res.json({ ok: true })
    })
    return app
  }

  it('should disable credentials when CORS_ORIGINS is wildcard (*)', async () => {
    // Set wildcard origin
    process.env.CORS_ORIGINS = '*'

    const app = createTestApp()

    const response = await request(app)
      .get('/api/test')
      .set('Origin', 'https://example.com')
      .expect(200)

    // When wildcard is used, Access-Control-Allow-Credentials should NOT be present
    // This prevents the security vulnerability where any origin can make authenticated requests
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.headers['access-control-allow-origin']).toBe('https://example.com')
  })

  it('should enable credentials when CORS_ORIGINS is specific allowlist', async () => {
    // Set specific origins
    process.env.CORS_ORIGINS = 'https://app.disciplr.com,https://staging.disciplr.com'

    const app = createTestApp()

    const response = await request(app)
      .get('/api/test')
      .set('Origin', 'https://app.disciplr.com')
      .expect(200)

    // When specific origins are allowlisted, credentials should be enabled
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    expect(response.headers['access-control-allow-origin']).toBe('https://app.disciplr.com')
  })

  it('should block requests from non-allowlisted origins when using specific origins', async () => {
    // Set specific origins
    process.env.CORS_ORIGINS = 'https://app.disciplr.com'

    const app = createTestApp()

    const response = await request(app)
      .get('/api/test')
      .set('Origin', 'https://evil.com')
      .expect(200) // The app still responds, but without CORS headers

    // The request should be blocked by CORS (no CORS headers will be sent)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('should handle server-to-server requests (no Origin header) correctly', async () => {
    process.env.CORS_ORIGINS = 'https://app.disciplr.com'

    const app = createTestApp()

    const response = await request(app)
      .get('/api/test')
      .expect(200)

    // Server-to-server requests (no Origin) are allowed and CORS middleware sets credentials header
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    // Even without Origin, credentials header can be set by CORS middleware
    expect(response.headers['access-control-allow-credentials']).toBe('true')
  })

  it('should block null origin regardless of configuration', async () => {
    process.env.CORS_ORIGINS = '*'

    const app = createTestApp()

    const response = await request(app)
      .get('/api/test')
      .set('Origin', 'null')
      .expect(200) // App still responds

    // 'null' origin should always be blocked
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
  })

  describe('OPTIONS preflight requests', () => {
    it('should handle wildcard preflight without credentials', async () => {
      process.env.CORS_ORIGINS = '*'

      const app = createTestApp()

      const response = await request(app)
        .options('/api/test')
        .set('Origin', 'https://example.com')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type')
        .expect(204) // CORS middleware responds with 204 for preflight

      expect(response.headers['access-control-allow-credentials']).toBeUndefined()
      expect(response.headers['access-control-allow-origin']).toBe('https://example.com')
      expect(response.headers['access-control-allow-methods']).toMatch(/POST/)
    })

    it('should handle specific origin preflight with credentials', async () => {
      process.env.CORS_ORIGINS = 'https://app.disciplr.com'

      const app = createTestApp()

      const response = await request(app)
        .options('/api/test')
        .set('Origin', 'https://app.disciplr.com')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type')
        .expect(204) // CORS middleware responds with 204 for preflight

      expect(response.headers['access-control-allow-credentials']).toBe('true')
      expect(response.headers['access-control-allow-origin']).toBe('https://app.disciplr.com')
      expect(response.headers['access-control-allow-methods']).toMatch(/POST/)
    })
  })
})
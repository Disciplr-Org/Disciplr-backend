import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { AppError, errorHandler } from '../middleware/errorHandler.js'

function buildApp(thrower: (req: Request, res: Response, next: NextFunction) => void) {
  const app = express()
  app.use(express.json())
  app.get('/test', thrower)
  app.use(errorHandler)
  return app
}

describe('errorHandler PII Guard', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  describe('in production mode (NODE_ENV=production)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production'
    })

    it('redacts PII from AppError details', async () => {
      const app = buildApp((_req, _res, next) => {
        next(AppError.validation('Invalid data', {
          email: 'leaked-user@example.com',
          creator: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
          safeField: 'is-ok'
        }))
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(400)
      const details = res.body.error.details
     expect(details.email).toMatch(/^[a-f0-9]{8}$/);
      expect(details.creator).toMatch(/^[a-f0-9]{8}$/);
      expect(details.safeField).toBe('is-ok')
    })

    it('strips internal details from generic Error messages', async () => {
      const app = buildApp((_req, _res, next) => {
        next(new Error('FATAL: connection to "db-prod-internal" failed for user "admin"'))
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(500)
      expect(res.body.error.message).toBe('Internal server error')
      expect(res.body.error.message).not.toContain('db-prod-internal')
    })

    it('strips stack traces from generic Error messages', async () => {
      const app = buildApp((_req, _res, next) => {
        const err = new Error('Something broke')
        err.stack = 'Error: Something broke\n    at /app/src/services/critical.js:123:45'
        next(err)
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(500)
      expect(res.body.error.message).toBe('Internal server error')
      expect(res.body.error.message).not.toContain('critical.js')
    })

    it('preserves correlation ID while sanitizing', async () => {
      const app = buildApp((_req, _res, next) => {
        next(new Error('Internal failure'))
      })

      const res = await request(app).get('/test').set('x-request-id', 'trace-me-123')
      expect(res.status).toBe(500)
      expect(res.body.error.message).toBe('Internal server error')
      expect(res.body.error.requestId).toBe('trace-me-123')
    })
  })

  describe('in development mode (NODE_ENV!=production)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development'
    })

    it('does NOT redact PII from AppError details', async () => {
      const app = buildApp((_req, _res, next) => {
        next(AppError.validation('Invalid data', {
          email: 'dev-user@example.com',
          creator: 'GDEVADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
        }))
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(400)
      const details = res.body.error.details
      expect(details.email).toBe('dev-user@example.com')
      expect(details.creator).toBe('GDEVADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
    })

    it('preserves the original message for generic Errors', async () => {
      const app = buildApp((_req, _res, next) => {
        next(new Error('SQLSTATE[23505]: Unique violation: 7 ERROR: duplicate key value violates unique constraint "users_email_key"'))
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(500)
      expect(res.body.error.message).toContain('duplicate key value')
    })

    it('preserves stack traces in the original message for generic Errors', async () => {
      const app = buildApp((_req, _res, next) => {
        const err = new Error('Dev mode error')
        err.stack = 'Error: Dev mode error\n    at /app/src/dev.js:10:20'
        next(err)
      })

      const res = await request(app).get('/test')
      expect(res.status).toBe(500)
      // The default behavior is to use the message, not the stack, but we ensure it's not the generic prod message.
      expect(res.body.error.message).toBe('Dev mode error')
    })
  })
})
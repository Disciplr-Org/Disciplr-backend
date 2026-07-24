import { describe, it, expect } from '@jest/globals'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { AppError, ErrorCode, errorHandler } from '../middleware/errorHandler.js'
import { notFound } from '../middleware/notFound.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildApp(thrower: (req: Request, res: Response, next: NextFunction) => void) {
  const app = express()
  app.use(express.json())
  app.get('/test', thrower)
  app.use(notFound)
  app.use(errorHandler)
  return app
}

// ─── AppError factories ───────────────────────────────────────────────────────

describe('AppError factories', () => {
  it('badRequest produces 400 + BAD_REQUEST code', () => {
    const e = AppError.badRequest('bad input')
    expect(e.status).toBe(400)
    expect(e.code).toBe(ErrorCode.BAD_REQUEST)
    expect(e.message).toBe('bad input')
  })

  it('validation produces 400 + VALIDATION_ERROR code', () => {
    const e = AppError.validation('invalid field', { field: 'email' })
    expect(e.status).toBe(400)
    expect(e.code).toBe(ErrorCode.VALIDATION_ERROR)
    expect(e.details).toEqual({ field: 'email' })
  })

  it('unauthorized produces 401', () => {
    const e = AppError.unauthorized()
    expect(e.status).toBe(401)
    expect(e.code).toBe(ErrorCode.UNAUTHORIZED)
  })

  it('forbidden produces 403', () => {
    const e = AppError.forbidden()
    expect(e.status).toBe(403)
    expect(e.code).toBe(ErrorCode.FORBIDDEN)
  })

  it('notFound produces 404', () => {
    const e = AppError.notFound('thing not found')
    expect(e.status).toBe(404)
    expect(e.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('notFound uses default message when none provided', () => {
    const e = AppError.notFound()
    expect(e.status).toBe(404)
    expect(e.code).toBe(ErrorCode.NOT_FOUND)
    expect(e.message).toBe('Not found')
  })

  it('conflict produces 409', () => {
    const e = AppError.conflict('already exists')
    expect(e.status).toBe(409)
    expect(e.code).toBe(ErrorCode.CONFLICT)
  })

  it('internal produces 500', () => {
    const e = AppError.internal()
    expect(e.status).toBe(500)
    expect(e.code).toBe(ErrorCode.INTERNAL_ERROR)
  })

  it('conflict produces 409', () => {
    const e = AppError.conflict('resource conflict')
    expect(e.status).toBe(409)
    expect(e.code).toBe(ErrorCode.CONFLICT)
    expect(e.message).toBe('resource conflict')
  })

  it('unprocessable produces 422', () => {
    const e = AppError.unprocessable('cannot process')
    expect(e.status).toBe(422)
    expect(e.code).toBe(ErrorCode.UNPROCESSABLE)
    expect(e.message).toBe('cannot process')
  })

  it('rateLimited produces 429 + RATE_LIMITED code', () => {
    const e = AppError.rateLimited()
    expect(e.status).toBe(429)
    expect(e.code).toBe(ErrorCode.RATE_LIMITED)
    expect(e.message).toBe('Too many requests')
  })

  it('rateLimited accepts a custom message', () => {
    const e = AppError.rateLimited('slow down')
    expect(e.status).toBe(429)
    expect(e.code).toBe(ErrorCode.RATE_LIMITED)
    expect(e.message).toBe('slow down')
  })

  it('payloadTooLarge produces 413 + PAYLOAD_TOO_LARGE code', () => {
    const e = AppError.payloadTooLarge()
    expect(e.status).toBe(413)
    expect(e.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE)
    expect(e.message).toBe('Payload too large')
  })

  it('payloadTooLarge accepts a custom message', () => {
    const e = AppError.payloadTooLarge('request body exceeds 1 MB limit')
    expect(e.status).toBe(413)
    expect(e.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE)
    expect(e.message).toBe('request body exceeds 1 MB limit')
  })
})

// ─── errorHandler middleware ──────────────────────────────────────────────────

describe('errorHandler middleware', () => {
  it('returns uniform JSON for AppError', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.badRequest('missing field'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: { code: 'BAD_REQUEST', message: 'missing field' },
    })
  })

  it('includes details when present', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.validation('invalid', { field: 'amount' }))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.details).toEqual({ field: 'amount' })
  })

  it('echoes x-request-id when provided', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.unauthorized())
    })

    const res = await request(app)
      .get('/test')
      .set('x-request-id', 'req-abc-123')

    expect(res.status).toBe(401)
    expect(res.body.error.requestId).toBe('req-abc-123')
  })

  it('hides internals for unknown errors (500)', async () => {
    const app = buildApp((_req, _res, next) => {
      next(new Error('db connection string: postgres://user:secret@host/db'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    })
    // Must not leak the raw error message
    expect(JSON.stringify(res.body)).not.toContain('secret')
  })

  it('handles non-Error thrown values', async () => {
    const app = buildApp((_req, _res, next) => {
      next('plain string error')
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('INTERNAL_ERROR')
  })

  it('returns 403 for AppError.forbidden', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.forbidden('no access'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(res.body.error.message).toBe('no access')
  })

  it('returns 404 for AppError.notFound', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.notFound('resource not found'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(res.body.error.message).toBe('resource not found')
  })

  it('returns 409 for AppError.conflict', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.conflict('resource already exists'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')
    expect(res.body.error.message).toBe('resource already exists')
  })

  it('returns 422 for AppError.unprocessable', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.unprocessable('entity cannot be processed'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('UNPROCESSABLE')
    expect(res.body.error.message).toBe('entity cannot be processed')
  })

  it('does not include requestId when header is absent', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.badRequest('bad request'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(400)
    expect(res.body.error.requestId).toBeUndefined()
  })

  it('does not include details when not provided', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.badRequest('bad request'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(400)
    expect(res.body.error.details).toBeUndefined()
  })

  it('preserves error message for generic errors in logs but not response', async () => {
    const app = buildApp((_req, _res, next) => {
      const err = new Error('sensitive database info')
      next(err)
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(500)
    expect(res.body.error.message).toBe('Internal server error')
    expect(res.body.error.code).toBe('INTERNAL_ERROR')
  })

  it('handles generic error without requestId', async () => {
    const app = buildApp((_req, _res, next) => {
      next(new Error('generic error'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('INTERNAL_ERROR')
    expect(res.body.error.requestId).toBeUndefined()
  })

  it('returns 429 for AppError.rateLimited', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.rateLimited('slow down'))
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('RATE_LIMITED')
    expect(res.body.error.message).toBe('slow down')
  })

  it('returns 413 for AppError.payloadTooLarge', async () => {
    const app = buildApp((_req, _res, next) => {
      next(AppError.payloadTooLarge())
    })

    const res = await request(app).get('/test')
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect(res.body.error.message).toBe('Payload too large')
  })
})

// ─── notFound middleware ──────────────────────────────────────────────────────

describe('notFound middleware', () => {
  it('returns 404 with NOT_FOUND code for unknown routes', async () => {
    const app = express()
    app.use(notFound)
    app.use(errorHandler)

    const res = await request(app).get('/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(res.body.error.message).toContain('/does-not-exist')
  })

  it('echoes x-request-id in notFound response when provided', async () => {
    const app = express()
    app.use(notFound)
    app.use(errorHandler)

    const res = await request(app)
      .get('/unknown-route')
      .set('x-request-id', 'req-xyz-789')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(res.body.error.requestId).toBe('req-xyz-789')
  })

  it('does not include requestId in notFound when header is absent', async () => {
    const app = express()
    app.use(notFound)
    app.use(errorHandler)

    const res = await request(app).get('/missing-route')
    expect(res.status).toBe(404)
    expect(res.body.error.requestId).toBeUndefined()
  })

  it('includes HTTP method in notFound error message', async () => {
    const app = express()
    app.use(notFound)
    app.use(errorHandler)

    const res = await request(app).post('/some-route')
    expect(res.status).toBe(404)
    expect(res.body.error.message).toContain('POST')
    expect(res.body.error.message).toContain('/some-route')
  })
})

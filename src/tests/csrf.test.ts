import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import express from 'express'
import { csrfProtection } from '../middleware/auth.js'

function mockReqRes(overrides: Partial<Request> = {}) {
  const req = {
    method: 'POST',
    headers: {},
    ...overrides,
  } as any as Request
  const res = {
    status: jest.fn<() => any>().mockReturnThis(),
    json: jest.fn<() => any>().mockReturnThis(),
  } as any as Response
  const next = jest.fn<() => void>()
  return { req, res, next }
}

describe('csrfProtection unit tests', () => {
  beforeEach(() => {
    process.env.CORS_ORIGINS = 'http://localhost:3000'
  })

  it('allows GET requests', () => {
    const { req, res, next } = mockReqRes({ method: 'GET' })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('allows HEAD requests', () => {
    const { req, res, next } = mockReqRes({ method: 'HEAD' })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('allows OPTIONS requests', () => {
    const { req, res, next } = mockReqRes({ method: 'OPTIONS' })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('exempts bearer token requests from CSRF check', () => {
    const { req, res, next } = mockReqRes({
      headers: {
        authorization: 'Bearer some-valid-token',
        origin: 'https://evil.com',
      },
    })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('exempts bearer token requests with no origin', () => {
    const { req, res, next } = mockReqRes({
      headers: { authorization: 'Bearer token123' },
    })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('allows request with no Origin and no Referer (non-browser)', () => {
    const { req, res, next } = mockReqRes({ method: 'POST' })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('allows POST with matching Origin', () => {
    const { req, res, next } = mockReqRes({
      headers: { origin: 'http://localhost:3000' },
    })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('blocks POST with mismatched Origin', () => {
    const { req, res, next } = mockReqRes({
      headers: { origin: 'https://evil.com' },
    })
    csrfProtection(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(next).not.toHaveBeenCalled()
  })

  it('blocks PUT with mismatched Origin', () => {
    const { req, res, next } = mockReqRes({
      method: 'PUT',
      headers: { origin: 'https://evil.com' },
    })
    csrfProtection(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
  })

  it('blocks PATCH with mismatched Origin', () => {
    const { req, res, next } = mockReqRes({
      method: 'PATCH',
      headers: { origin: 'https://evil.com' },
    })
    csrfProtection(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('blocks DELETE with mismatched Origin', () => {
    const { req, res, next } = mockReqRes({
      method: 'DELETE',
      headers: { origin: 'https://evil.com' },
    })
    csrfProtection(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('falls back to Referer when Origin is absent', () => {
    const { req, res, next } = mockReqRes({
      headers: { referer: 'http://localhost:3000/some-page' },
    })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('blocks request with mismatched Referer and no Origin', () => {
    const { req, res, next } = mockReqRes({
      headers: { referer: 'https://evil.com/some-page' },
    })
    csrfProtection(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('blocks request with malformed Referer', () => {
    const { req, res, next } = mockReqRes({
      headers: { referer: 'not-a-valid-url' },
    })
    csrfProtection(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('does not leak details in error response', () => {
    const { req, res, next } = mockReqRes({
      headers: { origin: 'https://evil.com' },
    })
    csrfProtection(req, res, next)
    const callArgs = (res.json as jest.Mock).mock.calls[0]?.[0]
    expect(callArgs).toEqual({ error: 'Forbidden' })
    expect(JSON.stringify(callArgs)).not.toContain('origin')
    expect(JSON.stringify(callArgs)).not.toContain('localhost')
    expect(JSON.stringify(callArgs)).not.toContain('http')
  })

  it('allows wildcard CORS config', () => {
    process.env.CORS_ORIGINS = '*'
    const { req, res, next } = mockReqRes({
      headers: { origin: 'https://anything.com' },
    })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('allows with matching Referer under wildcard', () => {
    process.env.CORS_ORIGINS = '*'
    const { req, res, next } = mockReqRes({
      method: 'POST',
      headers: { referer: 'https://anything.com/page' },
    })
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})

describe('csrfProtection integration tests', () => {
  beforeEach(() => {
    process.env.CORS_ORIGINS = 'http://localhost:3000'
  })

  function buildApp() {
    const app = express()
    app.use(express.json())
    // Inline csrfProtection to isolate tests from app.ts wiring
    app.use(csrfProtection)
    app.post('/api/test', (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    app.put('/api/test', (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    app.patch('/api/test', (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    app.delete('/api/test', (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    app.get('/api/test', (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    return app
  }

  it('allows POST with valid Origin', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/test')
      .set('Origin', 'http://localhost:3000')
      .send({})
    expect(res.status).toBe(200)
  })

  it('blocks POST with invalid Origin', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/test')
      .set('Origin', 'https://evil.com')
      .send({})
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Forbidden' })
  })

  it('blocks PUT with invalid Origin', async () => {
    const app = buildApp()
    const res = await request(app)
      .put('/api/test')
      .set('Origin', 'https://evil.com')
      .send({})
    expect(res.status).toBe(403)
  })

  it('blocks PATCH with invalid Origin', async () => {
    const app = buildApp()
    const res = await request(app)
      .patch('/api/test')
      .set('Origin', 'https://evil.com')
      .send({})
    expect(res.status).toBe(403)
  })

  it('blocks DELETE with invalid Origin', async () => {
    const app = buildApp()
    const res = await request(app)
      .delete('/api/test')
      .set('Origin', 'https://evil.com')
    expect(res.status).toBe(403)
  })

  it('allows GET even with invalid Origin', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/api/test')
      .set('Origin', 'https://evil.com')
    expect(res.status).toBe(200)
  })

  it('exempts Bearer token even with invalid Origin', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/test')
      .set('Authorization', 'Bearer some-valid-token')
      .set('Origin', 'https://evil.com')
      .send({})
    expect(res.status).toBe(200)
  })

  it('allows POST with no Origin and no Referer', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/test')
      .send({})
    expect(res.status).toBe(200)
  })

  it('allows POST with valid Referer', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/test')
      .set('Referer', 'http://localhost:3000/some-page')
      .send({})
    expect(res.status).toBe(200)
  })

  it('blocks POST with invalid Referer', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/test')
      .set('Referer', 'https://evil.com/some-page')
      .send({})
    expect(res.status).toBe(403)
  })

  it('prefers Origin over Referer when both present', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/test')
      .set('Origin', 'https://evil.com')
      .set('Referer', 'http://localhost:3000/page')
      .send({})
    expect(res.status).toBe(403)
  })

  it('allows POST with Bearer token and no Origin/Referer', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/test')
      .set('Authorization', 'Bearer token-123')
      .send({})
    expect(res.status).toBe(200)
  })
})

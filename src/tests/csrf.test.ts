import { describe, expect, it } from 'bun:test'
import express from 'express'
import request from 'supertest'
import { csrfProtection } from '../middleware/auth.js'

function buildApp() {
  const app = express()
  app.use(csrfProtection)
  app.all('/mutate', (_req, res) => {
    res.status(200).json({ ok: true })
  })
  return app
}

describe('CSRF protection for cookie-authenticated mutations', () => {
  it('rejects cookie-authenticated mutating requests without CSRF proof', async () => {
    const response = await request(buildApp())
      .post('/mutate')
      .set('Cookie', 'session=s1')

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'CSRF validation failed.' })
  })

  it('accepts a valid double-submit CSRF token', async () => {
    const response = await request(buildApp())
      .post('/mutate')
      .set('Cookie', 'session=s1; csrf_token=token-123')
      .set('x-csrf-token', 'token-123')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  it('accepts same-origin cookie-authenticated mutations', async () => {
    const response = await request(buildApp())
      .patch('/mutate')
      .set('Host', 'api.example.test')
      .set('Origin', 'http://api.example.test')
      .set('Cookie', 'session=s1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  it('blocks cross-origin cookie-authenticated mutations', async () => {
    const response = await request(buildApp())
      .delete('/mutate')
      .set('Host', 'api.example.test')
      .set('Origin', 'https://evil.example.test')
      .set('Cookie', 'session=s1')

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'CSRF validation failed.' })
  })

  it('exempts bearer-authenticated requests from CSRF checks', async () => {
    const response = await request(buildApp())
      .post('/mutate')
      .set('Origin', 'https://evil.example.test')
      .set('Cookie', 'session=s1')
      .set('Authorization', 'Bearer token')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  it('exempts API-key authenticated requests from CSRF checks', async () => {
    const response = await request(buildApp())
      .post('/mutate')
      .set('Origin', 'https://evil.example.test')
      .set('Cookie', 'session=s1')
      .set('x-api-key', 'dsk_test.secret')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  it('does not enforce CSRF on safe methods', async () => {
    const response = await request(buildApp())
      .get('/mutate')
      .set('Cookie', 'session=s1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })
})

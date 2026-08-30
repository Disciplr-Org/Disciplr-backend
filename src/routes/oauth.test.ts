import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../services/apiKeys.js', () => ({
  validateApiKey: vi.fn(),
}))

vi.mock('../lib/audit-logs.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue({ id: 'audit-log-id' }),
}))

vi.mock('../lib/auth-utils.js', () => ({
  getJwtSecret: vi.fn().mockReturnValue('test-secret'),
}))

vi.mock('../config/index.js', () => ({
  getEnv: vi.fn().mockReturnValue({ JWT_SECRET: 'test-secret' }),
}))

vi.mock('../middleware/rateLimiter.js', () => ({
  authRateLimiter: vi.fn((req: any, _res: any, next: any) => next()),
}))

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('signed-token'),
  },
}))

import { oauthRouter } from './oauth.js'
import { validateApiKey } from '../services/apiKeys.js'
import jwt from 'jsonwebtoken'

const createApp = () => {
  const app = express()
  app.use(oauthRouter)
  return app
}

describe('oauth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(validateApiKey).mockResolvedValue({
      valid: true,
      context: {
        apiKeyId: 'key-1',
        scopes: ['read:users', 'write:users'],
        orgId: 'org-1',
        userId: 'user-1',
      },
    })
    vi.mocked(jwt.sign).mockReturnValue('signed-token')
  })

  it('issues a token with valid credentials', async () => {
    const app = createApp()
    const res = await request(app)
      .post('/token')
      .send({ grant_type: 'client_credentials', client_id: 'key-1', client_secret: 'secret', scope: 'read:users' })
    expect(res.status).toBe(200)
    expect(res.body.access_token).toBe('signed-token')
    expect(res.body.scope).toBe('read:users')
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('returns 400 for unsupported grant type', async () => {
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'password', client_id: 'key-1', client_secret: 'secret' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unsupported_grant_type')
  })

  it('returns 400 when client_id or client_secret missing', async () => {
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('returns 401 for invalid client credentials', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({ valid: false, reason: 'unknown key' })
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: 'bad', client_secret: 'bad' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_client')
  })

  it('returns 401 when client_id mismatches', async () => {
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: 'other', client_secret: 'secret' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_client')
  })

  it('returns 400 for scope exceeding client grants', async () => {
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: 'key-1', client_secret: 'secret', scope: 'admin:all' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_scope')
  })

  it('returns 400 for too many scopes', async () => {
    const manyScopes = Array.from({ length: 21 }, (_, i) => `scope${i}`).join(' ')
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: 'key-1', client_secret: 'secret', scope: manyScopes })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_scope')
  })

  it('returns 400 for too long scope string', async () => {
    const longScope = 'a'.repeat(1300)
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: 'key-1', client_secret: 'secret', scope: longScope })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_scope')
  })
})

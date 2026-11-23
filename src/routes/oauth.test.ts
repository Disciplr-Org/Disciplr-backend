// Uses jest.unstable_mockModule + dynamic import because the suite runs under Jest ESM (--experimental-vm-modules).
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'

const mockValidateApiKey = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockCreateAuditLog = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 'audit-log-id' })
const mockGetJwtSecret = jest.fn<() => string>().mockReturnValue('test-secret')
const mockGetEnv = jest.fn<() => Record<string, string>>().mockReturnValue({ JWT_SECRET: 'test-secret' })
const mockAuthRateLimiter = jest.fn((_req: Request, _res: Response, next: NextFunction) => next())
const mockJwtSign = jest.fn<(...args: unknown[]) => string>().mockReturnValue('signed-token')

jest.unstable_mockModule('../services/apiKeys.js', () => ({
  validateApiKey: mockValidateApiKey,
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

jest.unstable_mockModule('../lib/auth-utils.js', () => ({
  getJwtSecret: mockGetJwtSecret,
}))

jest.unstable_mockModule('../config/index.js', () => ({
  getEnv: mockGetEnv,
}))

jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  authRateLimiter: mockAuthRateLimiter,
}))

jest.unstable_mockModule('jsonwebtoken', () => ({
  default: {
    sign: mockJwtSign,
  },
}))

const { oauthRouter } = await import('./oauth.js')

const CLIENT_ID_1 = '00000000-0000-4000-8000-000000000001'
const CLIENT_ID_2 = '00000000-0000-4000-8000-000000000002'
const CLIENT_ID_OTHER = '00000000-0000-4000-8000-000000000099'

const createApp = () => {
  const app = express()
  app.use(express.json())
  app.use(oauthRouter)
  return app
}

describe('oauth routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateAuditLog.mockResolvedValue({ id: 'audit-log-id' })
    mockGetJwtSecret.mockReturnValue('test-secret')
    mockGetEnv.mockReturnValue({ JWT_SECRET: 'test-secret' })
    mockAuthRateLimiter.mockImplementation((_req: Request, _res: Response, next: NextFunction) => next())
    mockValidateApiKey.mockResolvedValue({
      valid: true,
      context: {
        apiKeyId: CLIENT_ID_1,
        scopes: ['read:users', 'write:users'],
        orgId: 'org-1',
        userId: 'user-1',
      },
    })
    mockJwtSign.mockReturnValue('signed-token')
  })

  it('issues a token with valid credentials', async () => {
    const app = createApp()
    const res = await request(app)
      .post('/token')
      .send({ grant_type: 'client_credentials', client_id: CLIENT_ID_1, client_secret: 'secret', scope: 'read:users' })
    expect(res.status).toBe(200)
    expect(res.body.access_token).toBe('signed-token')
    expect(res.body.scope).toBe('read:users')
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('returns 400 for unsupported grant type', async () => {
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'password', client_id: CLIENT_ID_1, client_secret: 'secret' })
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
    mockValidateApiKey.mockResolvedValue({ valid: false, reason: 'invalid' })
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: CLIENT_ID_2, client_secret: 'bad' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_client')
  })

  it('returns 401 when client_id mismatches', async () => {
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: CLIENT_ID_OTHER, client_secret: 'secret' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_client')
  })

  it('returns 400 for scope exceeding client grants', async () => {
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: CLIENT_ID_1, client_secret: 'secret', scope: 'admin:all' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_scope')
  })

  it('returns 400 for too many scopes', async () => {
    const manyScopes = Array.from({ length: 21 }, (_, i) => `scope${i}`).join(' ')
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: CLIENT_ID_1, client_secret: 'secret', scope: manyScopes })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_scope')
  })

  it('returns 400 for too long scope string', async () => {
    const longScope = 'a'.repeat(1300)
    const app = createApp()
    const res = await request(app).post('/token').send({ grant_type: 'client_credentials', client_id: CLIENT_ID_1, client_secret: 'secret', scope: longScope })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import request from 'supertest'
import express from 'express'

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'ADMIN', jmti: 'jmti-1' }
    next()
  }),
}))

jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: jest.fn().mockReturnValue((req: any, _res: any, next: any) => next()),
}))

jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  apiKeyRateLimiter: jest.fn((req: any, _res: any, next: any) => next()),
}))

jest.unstable_mockModule('../services/apiKeys.js', () => ({
  createApiKey: jest.fn(),
  listApiKeysForUser: jest.fn(),
  listApiKeysForOrg: jest.fn(),
  revokeApiKey: jest.fn(),
  rotateApiKey: jest.fn(),
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: 'audit-log-id' }),
}))

// Import after mocks (jest.unstable_mockModule is not hoisted in ESM)
const { apiKeysRouter } = await import('./apiKeys.js')
const { createApiKey, listApiKeysForUser, revokeApiKey, rotateApiKey } = await import('../services/apiKeys.js')
const { createAuditLog } = await import('../lib/audit-logs.js')

// The routes validate :id as a UUID (apiKeyIdParamSchema), so fixtures use real UUIDs.
const KEY_ID = '11111111-1111-4111-8111-111111111111'
const UNKNOWN_KEY_ID = '22222222-2222-4222-8222-222222222222'

const createApp = () => {
  const app = express()
  app.use(apiKeysRouter)
  return app
}

describe('api keys routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const keyRecord = {
      id: 'key-1',
      label: 'Test Key',
      scopes: ['read'],
      createdAt: new Date('2024-01-01'),
      revokedAt: null,
      lastUsedAt: null,
      requestCount: 0,
      lastIp: null,
      keyHash: 'hash',
    }
    jest.mocked(listApiKeysForUser).mockResolvedValue([keyRecord])
    jest.mocked(createApiKey).mockResolvedValue({ apiKey: 'plain-key', record: keyRecord })
    jest.mocked(rotateApiKey).mockResolvedValue({ apiKey: 'rotated-key', record: keyRecord })
    jest.mocked(revokeApiKey).mockResolvedValue(keyRecord)
  })

  it('lists API keys with pagination', async () => {
    const app = createApp()
    const res = await request(app).get('/?limit=10&offset=0')
    expect(res.status).toBe(200)
    expect(res.body.apiKeys).toHaveLength(1)
    expect(res.body.pagination.total).toBe(1)
    expect(res.body.apiKeys[0]).not.toHaveProperty('keyHash')
  })

  it('clamps limit to max', async () => {
    const app = createApp()
    const res = await request(app).get('/?limit=1000&offset=2')
    expect(res.status).toBe(200)
    expect(res.body.pagination.limit).toBe(100)
  })

  it('creates an API key', async () => {
    const app = createApp()
    const res = await request(app).post('/').send({ label: 'New Key', scopes: ['read:vaults'] })
    expect(res.status).toBe(201)
    expect(res.body.apiKey).toBe('plain-key')
    expect(createApiKey).toHaveBeenCalledWith({ label: 'New Key', scopes: ['read:vaults'], userId: 'user-1', orgId: undefined })
  })

  it('returns 400 for invalid scope', async () => {
    const app = createApp()
    const res = await request(app).post('/').send({ label: 'Key', scopes: ['invalid'] })
    expect(res.status).toBe(400)
  })

  it('returns 400 for label too long', async () => {
    const app = createApp()
    const res = await request(app).post('/').send({ label: 'a'.repeat(101), scopes: ['read'] })
    expect(res.status).toBe(400)
  })

  it('rotates an API key', async () => {
    const app = createApp()
    const res = await request(app).post(`/${KEY_ID}/rotate`)
    expect(res.status).toBe(200)
    expect(res.body.apiKey).toBe('rotated-key')
    expect(createAuditLog).toHaveBeenCalled()
  })

  it('returns 404 when rotating an unknown key', async () => {
    jest.mocked(rotateApiKey).mockResolvedValue(null)
    const app = createApp()
    const res = await request(app).post(`/${UNKNOWN_KEY_ID}/rotate`)
    expect(res.status).toBe(404)
  })

  it('revokes an API key', async () => {
    const app = createApp()
    const res = await request(app).post(`/${KEY_ID}/revoke`)
    expect(res.status).toBe(200)
    expect(revokeApiKey).toHaveBeenCalledWith(KEY_ID, 'user-1')
  })

  it('returns 404 when revoking an unknown key', async () => {
    jest.mocked(revokeApiKey).mockResolvedValue(null)
    const app = createApp()
    const res = await request(app).post(`/${UNKNOWN_KEY_ID}/revoke`)
    expect(res.status).toBe(404)
  })
})

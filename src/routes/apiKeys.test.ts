import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../middleware/auth.js', () => ({
  authenticate: vi.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'ADMIN', jmti: 'jmti-1' }
    next()
  }),
}))

vi.mock('../middleware/stepUp.js', () => ({
  requireStepUp: vi.fn().mockReturnValue((req: any, _res: any, next: any) => next()),
}))

vi.mock('../middleware/rateLimiter.js', () => ({
  apiKeyRateLimiter: vi.fn((req: any, _res: any, next: any) => next()),
}))

vi.mock('../services/apiKeys.js', () => ({
  createApiKey: vi.fn(),
  listApiKeysForUser: vi.fn(),
  listApiKeysForOrg: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
}))

vi.mock('../lib/audit-logs.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue({ id: 'audit-log-id' }),
}))

import { apiKeysRouter } from './apiKeys.js'
import { createApiKey, listApiKeysForUser, revokeApiKey, rotateApiKey } from '../services/apiKeys.js'
import { createAuditLog } from '../lib/audit-logs.js'

const createApp = () => {
  const app = express()
  app.use(apiKeysRouter)
  return app
}

describe('api keys routes', () => {
  beforeEach(() => {
    vi_.clearAllMocks()
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
    vi_.mocked(listApiKeysForUser).mockResolvedValue([keyRecord])
    vi_.mocked(createApiKey).mockResolvedValue({ apiKey: 'plain-key', record: keyRecord })
    vi_.mocked(rotateApiKey).mockResolvedValue({ apiKey: 'rotated-key', record: keyRecord })
    vi_.mocked(revokeApiKey).mockResolvedValue(keyRecord)
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
    const res = await request(app).post('/').send({ label: 'New Key', scopes: ['read'] })
    expect(res.status).toBe(201)
    expect(res.body.apiKey).toBe('plain-key')
    expect(createApiKey).toHaveBeenCalledWith({ label: 'New Key', scopes: ['read'], userId: 'user-1', orgId: undefined })
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
    const res = await request(app).post('/key-1/rotate')
    expect(res.status).toBe(200)
    expect(res.body.apiKey).toBe('rotated-key')
    expect(createAuditLog).toHaveBeenCalled()
  })

  it('returns 404 when rotating an unknown key', async () => {
    vi_.mocked(rotateApiKey).mockResolvedValue(null)
    const app = createApp()
    const res = await request(app).post('/unknown/rotate')
    expect(res.status).toBe(404)
  })

  it('revokes an API key', async () => {
    const app = createApp()
    const res = await request(app).post('/key-1/revoke')
    expect(res.status).toBe(200)
    expect(revokeApiKey).toHaveBeenCalledWith('key-1', 'user-1')
  })

  it('returns 404 when revoking an unknown key', async () => {
    vi_.mocked(revokeApiKey).mockResolvedValue(null)
    const app = createApp()
    const res = await request(app).post('/unknown/revoke')
    expect(res.status).toBe(404)
  })
})

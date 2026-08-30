import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { ApiScope } from '../types/auth.js'

// ---------------------------------------------------------------------------
// Module mocks (jest.unstable_mockModule, must precede the imports)
// ---------------------------------------------------------------------------

const mockOrgs = new Map<string, { id: string }>()
const mockMemberships = new Map<string, { role: string }>()

const mockDb = jest.fn((table: string) => ({
  where: jest.fn((pred: Record<string, string>) => ({
    first: jest.fn(async () => {
      if (table === 'organizations') return mockOrgs.get(pred.id) ?? null
      if (table === 'org_members') return mockMemberships.get(`${pred.org_id}:${pred.user_id}`) ?? null
      return null
    }),
  })),
}))

const mockCreateAuditLog = jest.fn(async () => ({ id: 'audit-1' }))

jest.unstable_mockModule('../db/index.js', () => ({ default: mockDb }))
jest.unstable_mockModule('../db/pool.js', () => ({ getPgPool: () => null }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog: mockCreateAuditLog }))
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      userId: req.header('x-test-user-id') ?? 'missing-user',
    } as any
    next()
  },
}))
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  apiKeyRateLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))
jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

const { apiKeysRouter, getApiKeyUsageHandler } = await import('../routes/apiKeys.js')
const { createApiKey, resetApiKeysTable } = await import('../services/apiKeys.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

const USER_ID = 'c0a6e0e8-4f5e-4a9c-9f4e-111111111111'
const OTHER_USER = 'c0a6e0e8-4f5e-4a9c-9f4e-222222222222'
const ORG_ID = 'c0a6e0e8-4f5e-4a9c-9f4e-333333333333'

const buildApp = (extra?: express.Express) => {
  const app = express()
  app.use(express.json())
  app.use('/api/keys', apiKeysRouter)
  app.get('/orgs/:orgId/keys/usage', (req, res, next) => {
    req.user = { userId: req.header('x-test-user-id') } as any
    next()
  }, getApiKeyUsageHandler)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await resetApiKeysTable()
  mockOrgs.clear()
  mockMemberships.clear()
  mockOrgs.set(ORG_ID, { id: ORG_ID })
  mockMemberships.set(`${ORG_ID}:${USER_ID}`, { role: 'admin' })
})

const createViaService = async (overrides: Record<string, unknown> = {}) => {
  const { apiKey, record } = await createApiKey({
    label: 'lifecycle',
    scopes: [ApiScope.ReadVaults],
    userId: USER_ID,
    ...overrides,
  } as any)
  return { apiKey, record }
}

describe('GET /api/keys – listing', () => {
  it('returns only keys owned by the authenticated user', async () => {
    await createViaService({ userId: USER_ID, label: 'mine' })
    await createViaService({ userId: OTHER_USER, label: 'not-mine' })
    const app = buildApp()
    const res = await request(app).get('/api/keys').set('x-test-user-id', USER_ID)
    expect(res.status).toBe(200)
    expect(res.body.apiKeys.map((k: any) => k.label)).toEqual(['mine'])
    expect(res.body.apiKeys[0].keyHash).toBeUndefined()
  })
})

describe('POST /api/keys – create boundary validation', () => {
  const validBody = { label: 'my key', scopes: [ApiScope.ReadVaults] }

  it('rejects an empty label', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/keys').set('x-test-user-id', USER_ID).send({ ...validBody, label: '  ' })
    expect(res.status).toBe(400)
  })

  it('rejects an oversized label', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/keys').set('x-test-user-id', USER_ID).send({ ...validBody, label: 'A'.repeat(121) })
    expect(res.status).toBe(400)
  })

  it('rejects an empty scopes array', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/keys').set('x-test-user-id', USER_ID).send({ ...validBody, scopes: [] })
    expect(res.status).toBe(400)
  })

  it('rejects duplicate scopes', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ ...validBody, scopes: [ApiScope.ReadVaults, ApiScope.ReadVaults] })
    expect(res.status).toBe(400)
  })

  it('rejects an out-of-enum scope', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ ...validBody, scopes: ['read:everything'] })
    expect(res.status).toBe(400)
  })

  it('rejects more than 30 scopes', async () => {
    const app = buildApp()
    const scopes = Array.from({ length: 31 })
      .map((_, i) => `read:${i}`)
      .join(' ')
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ ...validBody, scopes: JSON.parse(`[${scopes.split(' ').map((s) => `"${s}"`).join(',')}]`) })
    expect(res.status).toBe(400)
  })

  it('rejects a malformed orgId', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/keys').set('x-test-user-id', USER_ID).send({ ...validBody, orgId: 'org-abc' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/keys – org ownership', () => {
  it('binds a key to an org the caller belongs to', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ label: 'org key', scopes: [ApiScope.ReadVaults], orgId: ORG_ID })
    expect(res.status).toBe(201)
    expect(res.body.apiKeyMeta.orgId).toBe(ORG_ID)
  })

  it('returns 404 when the org does not exist', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ label: 'bad org', scopes: [ApiScope.ReadVaults], orgId: 'c0a6e0e8-4f5e-4a9c-9f4e-444444444444' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('returns 403 when the caller is not a member of the org', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', OTHER_USER)
      .send({ label: 'foreign org', scopes: [ApiScope.ReadVaults], orgId: ORG_ID })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })
})

describe('POST /api/keys/:id/rotate', () => {
  it('rotates a key owned by the caller', async () => {
    const { record } = await createViaService()
    const app = buildApp()
    const res = await request(app)
      .post(`/api/keys/${record.id}/rotate`)
      .set('x-test-user-id', USER_ID)
      .send({})
    expect(res.status).toBe(200)
    expect(typeof res.body.apiKey).toBe('string')
    expect(res.body.apiKey).not.toBe(record.id)
    expect(res.body.apiKeyMeta.id).toBe(record.id)
  })

  it('returns 404 for a key owned by a different user', async () => {
    const { record } = await createViaService({ userId: OTHER_USER })
    const app = buildApp()
    const res = await request(app)
      .post(`/api/keys/${record.id}/rotate`)
      .set('x-test-user-id', USER_ID)
      .send({})
    expect(res.status).toBe(404)
  })

  it('rejects a malformed key id', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys/not-a-uuid/rotate')
      .set('x-test-user-id', USER_ID)
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /api/keys/:id/revoke', () => {
  it('revokes a key owned by the caller and removes it from listings', async () => {
    const { record } = await createViaService()
    const app = buildApp()
    const revoke = await request(app)
      .post(`/api/keys/${record.id}/revoke`)
      .set('x-test-user-id', USER_ID)
      .send({})
    expect(revoke.status).toBe(200)
    expect(revoke.body.apiKeyMeta.revokedAt).toBeTruthy()

    const list = await request(app).get('/api/keys').set('x-test-user-id', USER_ID)
    expect(list.body.apiKeys).toHaveLength(1)
    expect(list.body.apiKeys[0].revokedAt).toBeTruthy()
  })

  it('returns 404 for a key owned by a different user', async () => {
    const { record } = await createViaService({ userId: OTHER_USER })
    const app = buildApp()
    const res = await request(app)
      .post(`/api/keys/${record.id}/revoke`)
      .set('x-test-user-id', USER_ID)
      .send({})
    expect(res.status).toBe(404)
  })
})

describe('GET /orgs/:orgId/keys/usage – getApiKeyUsageHandler', () => {
  it('rejects requests without an authenticated user', async () => {
    const app = buildApp()
    const res = await request(app).get(`/orgs/${ORG_ID}/keys/usage`)
    expect(res.status).toBe(401)
  })

  it('rejects a malformed orgId', async () => {
    const app = buildApp()
    const res = await request(app).get('/orgs/%20/keys/usage').set('x-test-user-id', USER_ID)
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown org', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/orgs/c0a6e0e8-4f5e-4a9c-9f4e-444444444444/keys/usage')
      .set('x-test-user-id', USER_ID)
    expect(res.status).toBe(404)
  })

  it('returns 403 for a non-member', async () => {
    const app = buildApp()
    const res = await request(app).get(`/orgs/${ORG_ID}/keys/usage`).set('x-test-user-id', OTHER_USER)
    expect(res.status).toBe(403)
  })

  it('returns usage for an org the caller belongs to', async () => {
    await createViaService({ orgId: ORG_ID })
    const app = buildApp()
    const res = await request(app).get(`/orgs/${ORG_ID}/keys/usage`).set('x-test-user-id', USER_ID)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.usage)).toBe(true)
    expect(res.body.usage).toHaveLength(1)
    expect(res.body.usage[0].keyHash).toBeUndefined()
    expect(res.body.usage[0].id).toBeDefined()
  })
})
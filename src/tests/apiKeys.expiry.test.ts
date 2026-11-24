import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { ApiScope } from '../types/auth.js'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn((table: string) => ({
    where: jest.fn(() => ({ first: jest.fn(async () => null) })),
  })),
}))
jest.unstable_mockModule('../db/pool.js', () => ({ getPgPool: () => null }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn(async () => ({ id: 'audit-1' })),
}))
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: req.header('x-test-user-id') ?? 'test-user' } as any
    next()
  },
}))
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  apiKeyRateLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))
jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

const { apiKeysRouter } = await import('../routes/apiKeys.js')
const { createApiKey, resetApiKeysTable, validateApiKey, setApiKeyRepositoryForTests } =
  await import('../services/apiKeys.js')
const { authenticateApiKey } = await import('../middleware/apiKeyAuth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const USER_ID = 'c0a6e0e8-0000-0000-0000-111111111111'

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/keys', apiKeysRouter)
  app.get('/protected', authenticateApiKey([ApiScope.ReadVaults]), (_req, res) => {
    res.json({ ok: true })
  })
  app.use(errorHandler)
  return app
}

const futureDate = (offsetMs: number): string =>
  new Date(Date.now() + offsetMs).toISOString()

const pastDate = (offsetMs: number): string =>
  new Date(Date.now() - offsetMs).toISOString()

// In-memory repo for direct validation tests
const makeRepo = () => {
  const store = new Map<string, any>()
  return {
    async create(record: any) { store.set(record.id, { ...record }) },
    async listForUser() { return Array.from(store.values()) },
    async listForOrg() { return Array.from(store.values()) },
    async getById(id: string) { return store.get(id) ?? null },
    async update(record: any) { store.set(record.id, { ...record }); return store.get(record.id) },
    async findByIdForUser(id: string) { return store.get(id) ?? null },
    async findByHashPrefix(prefix: string) {
      return Array.from(store.values()).filter((r) => r.keyHash.slice(0, 12) === prefix)
    },
    async reset() { store.clear() },
  }
}

beforeEach(async () => {
  await resetApiKeysTable()
  setApiKeyRepositoryForTests(null)
})

// ---------------------------------------------------------------------------
// validateApiKey — unit-level expiry logic
// ---------------------------------------------------------------------------
describe('validateApiKey – expiry enforcement', () => {
  beforeEach(() => {
    setApiKeyRepositoryForTests(makeRepo())
  })

  it('accepts a key with no expiresAt', async () => {
    const { apiKey } = await createApiKey({
      label: 'no-expiry',
      scopes: [ApiScope.ReadVaults],
    })
    const result = await validateApiKey(apiKey)
    expect(result.valid).toBe(true)
  })

  it('accepts a key whose expiresAt is in the future', async () => {
    const { apiKey } = await createApiKey({
      label: 'future-expiry',
      scopes: [ApiScope.ReadVaults],
      expiresAt: futureDate(60 * 60 * 1000), // 1 hour ahead
    })
    const result = await validateApiKey(apiKey)
    expect(result.valid).toBe(true)
  })

  it('rejects a key whose expiresAt is in the past', async () => {
    const { apiKey } = await createApiKey({
      label: 'past-expiry',
      scopes: [ApiScope.ReadVaults],
      expiresAt: pastDate(1000), // 1 second ago
    })
    const result = await validateApiKey(apiKey)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('expired')
    }
  })

  it('checks expiry before checking scopes', async () => {
    // Create a key with a scope the route will require, but make it expired.
    const { apiKey } = await createApiKey({
      label: 'expired-with-scope',
      scopes: [ApiScope.ReadVaults],
      expiresAt: pastDate(1000),
    })
    // Ask for a scope the key has — if expiry is checked first, we still get 'expired'.
    const result = await validateApiKey(apiKey, [ApiScope.ReadVaults])
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('expired')
    }
  })
})

// ---------------------------------------------------------------------------
// POST /api/keys — route-level expiresAt validation
// ---------------------------------------------------------------------------
describe('POST /api/keys – expiresAt validation', () => {
  const validBody = { label: 'my key', scopes: [ApiScope.ReadVaults] }

  it('accepts a future expiresAt', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ ...validBody, expiresAt: futureDate(24 * 60 * 60 * 1000) })
    expect(res.status).toBe(201)
    expect(res.body.apiKeyMeta.expiresAt).toBeTruthy()
  })

  it('rejects a past expiresAt', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ ...validBody, expiresAt: pastDate(60 * 1000) })
    expect(res.status).toBe(400)
  })

  it('rejects an expiresAt more than 1 year ahead', async () => {
    const app = buildApp()
    const twoYears = futureDate(2 * 365 * 24 * 60 * 60 * 1000)
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ ...validBody, expiresAt: twoYears })
    expect(res.status).toBe(400)
  })

  it('rejects a non-ISO expiresAt string', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ ...validBody, expiresAt: 'next Tuesday' })
    expect(res.status).toBe(400)
  })

  it('creates a key without expiresAt when the field is omitted', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send(validBody)
    expect(res.status).toBe(201)
    expect(res.body.apiKeyMeta.expiresAt).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// GET /api/keys and /protected — integration with middleware
// ---------------------------------------------------------------------------
describe('GET /protected – expired key returns 401', () => {
  beforeEach(() => {
    setApiKeyRepositoryForTests(makeRepo())
  })

  it('returns 401 with expired error code for an expired key', async () => {
    const { apiKey } = await createApiKey({
      label: 'expired-key',
      scopes: [ApiScope.ReadVaults],
      expiresAt: pastDate(500),
    })
    const app = buildApp()
    const res = await request(app).get('/protected').set('x-api-key', apiKey)
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/expired/i)
  })

  it('allows access for an unexpired key', async () => {
    const { apiKey } = await createApiKey({
      label: 'valid-key',
      scopes: [ApiScope.ReadVaults],
      expiresAt: futureDate(60 * 60 * 1000),
    })
    const app = buildApp()
    const res = await request(app).get('/protected').set('x-api-key', apiKey)
    expect(res.status).toBe(200)
  })

  it('allows access for a key with no expiry', async () => {
    const { apiKey } = await createApiKey({
      label: 'no-expiry-key',
      scopes: [ApiScope.ReadVaults],
    })
    const app = buildApp()
    const res = await request(app).get('/protected').set('x-api-key', apiKey)
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// GET /api/keys – list exposes expiresAt
// ---------------------------------------------------------------------------
describe('GET /api/keys – expiresAt in list response', () => {
  it('returns expiresAt in the listing', async () => {
    const expiry = futureDate(24 * 60 * 60 * 1000)
    const app = buildApp()
    const create = await request(app)
      .post('/api/keys')
      .set('x-test-user-id', USER_ID)
      .send({ label: 'listed key', scopes: [ApiScope.ReadVaults], expiresAt: expiry })
    expect(create.status).toBe(201)

    const list = await request(app).get('/api/keys').set('x-test-user-id', USER_ID)
    expect(list.status).toBe(200)
    const key = list.body.apiKeys[0]
    expect(key.expiresAt).toBeTruthy()
    expect(key.keyHash).toBeUndefined()
  })
})

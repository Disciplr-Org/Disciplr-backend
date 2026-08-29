/**
 * Issue #1543 – API key lifecycle coverage
 *
 * Covers gaps beyond apiKeys.timing.test.ts and apiKeyAuth.test.ts:
 *
 *  Route layer (apiKeysRouter):
 *  - POST /api/api-keys: authenticated, label/scope validation, no keyHash leak
 *  - GET  /api/api-keys: returns only the requesting user's keys, strips keyHash
 *  - POST /api/api-keys/:id/rotate: success, returns usable key; cross-user blocked
 *  - POST /api/api-keys/:id/rotate: blocked when key is already revoked
 *  - POST /api/api-keys/:id/revoke: success with step-up; cross-user blocked
 *
 *  authenticateApiKey middleware:
 *  - Missing x-api-key header → 401
 *  - Revoked key → 401 "revoked"
 *  - Key with forbidden scope → 403
 *  - Valid key → next() with apiKeyAuth on req
 *
 *  requireScopes middleware:
 *  - No apiKeyAuth present → pass-through (allows JWT-only requests)
 *  - apiKeyAuth lacks the required scope → 403
 *  - apiKeyAuth has the required scope → next()
 *
 * Refs #1543
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import express from 'express'
import request from 'supertest'

import { ApiScope } from '../types/auth.js'

// ── Mock declarations ─────────────────────────────────────────────────────────

// Shared fake JWTPayload injected by the mock authenticate middleware
const fakeUser = { userId: 'default-user', role: 'USER', jti: 'jti-default' }

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).user = (req as any)._mockUser ?? fakeUser
    next()
  },
}))

jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn<any>().mockResolvedValue({ id: 'audit-id' }),
}))

// ── Dynamic imports ───────────────────────────────────────────────────────────

const {
  createApiKey,
  validateApiKey,
  revokeApiKey,
  resetApiKeysTable,
  setApiKeyRepositoryForTests,
} = await import('../services/apiKeys.js')
const { apiKeysRouter } = await import('../routes/apiKeys.js')
const { authenticateApiKey, requireScopes } = await import('../middleware/apiKeyAuth.js')

// ── In-memory repository factory ──────────────────────────────────────────────

const makeRepo = () => {
  const store = new Map<string, any>()
  return {
    async create(record: any) { store.set(record.id, { ...record }) },
    async listForUser(userId: string) {
      return Array.from(store.values())
        .filter((r: any) => r.userId === userId)
        .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))
    },
    async listForOrg(orgId: string) {
      return Array.from(store.values()).filter((r: any) => r.orgId === orgId)
    },
    async getById(id: string) { return store.get(id) ?? null },
    async update(record: any) {
      store.set(record.id, { ...record })
      return store.get(record.id)
    },
    async findByIdForUser(id: string, userId: string) {
      const r = store.get(id)
      return r && r.userId === userId ? r : null
    },
    async findByHashPrefix(prefix: string) {
      return Array.from(store.values()).filter(
        (r: any) => typeof r.keyHash === 'string' && r.keyHash.slice(0, 12) === prefix,
      )
    },
    async reset() { store.clear() },
  }
}

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp(overrideUserId?: string) {
  const app = express()
  app.use(express.json())
  // Let tests override the authenticated user via request header
  app.use((req, _res, next) => {
    const override = req.header('x-mock-user-id')
    if (override) {
      ;(req as any)._mockUser = { userId: override, role: 'USER', jti: 'jti-test' }
    }
    next()
  })
  app.use('/api/api-keys', apiKeysRouter)
  return app
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  setApiKeyRepositoryForTests(makeRepo() as any)
  await resetApiKeysTable()
})

afterEach(async () => {
  await resetApiKeysTable()
  setApiKeyRepositoryForTests(null)
})

// ── POST /api/api-keys ────────────────────────────────────────────────────────

describe('POST /api/api-keys – create', () => {
  it('creates a key and returns the raw apiKey + meta (no keyHash)', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/api-keys')
      .set('x-mock-user-id', 'user-create')
      .send({ label: 'my key', scopes: ['read:vaults'] })

    expect(res.status).toBe(201)
    expect(typeof res.body.apiKey).toBe('string')
    expect(res.body.apiKey).toMatch(/^dsk_/)
    expect(res.body.apiKeyMeta.label).toBe('my key')
    expect(res.body.apiKeyMeta.scopes).toContain('read:vaults')
    // keyHash must NEVER be exposed
    expect(res.body.apiKeyMeta.keyHash).toBeUndefined()
    expect(res.body.keyHash).toBeUndefined()
  })

  it('returns 400 for missing label', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/api-keys')
      .set('x-mock-user-id', 'user-create')
      .send({ scopes: ['read:vaults'] })

    expect(res.status).toBe(400)
  })

  it('returns 400 for an unrecognized scope value', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/api-keys')
      .set('x-mock-user-id', 'user-create')
      .send({ label: 'bad', scopes: ['read:vaults', 'write:nonexistent'] })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('accepts an empty scopes array', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/api-keys')
      .set('x-mock-user-id', 'user-create')
      .send({ label: 'no-scopes', scopes: [] })

    expect(res.status).toBe(201)
    expect(res.body.apiKeyMeta.scopes).toEqual([])
  })
})

// ── GET /api/api-keys ─────────────────────────────────────────────────────────

describe('GET /api/api-keys – list', () => {
  it('returns only the requesting user\'s keys', async () => {
    // Create keys for two different users
    await createApiKey({ label: 'user-a-key', scopes: [], userId: 'user-a' })
    await createApiKey({ label: 'user-b-key', scopes: [], userId: 'user-b' })

    const app = buildApp()
    const res = await request(app)
      .get('/api/api-keys')
      .set('x-mock-user-id', 'user-a')

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.apiKeys)).toBe(true)
    expect(res.body.apiKeys).toHaveLength(1)
    expect(res.body.apiKeys[0].label).toBe('user-a-key')
  })

  it('returns an empty array when the user has no keys', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/api/api-keys')
      .set('x-mock-user-id', 'no-keys-user')

    expect(res.status).toBe(200)
    expect(res.body.apiKeys).toEqual([])
  })

  it('strips keyHash from every listed record', async () => {
    await createApiKey({ label: 'listed', scopes: [], userId: 'list-user' })

    const app = buildApp()
    const res = await request(app)
      .get('/api/api-keys')
      .set('x-mock-user-id', 'list-user')

    expect(res.status).toBe(200)
    for (const key of res.body.apiKeys) {
      expect(key.keyHash).toBeUndefined()
    }
  })
})

// ── POST /api/api-keys/:id/rotate ─────────────────────────────────────────────

describe('POST /api/api-keys/:id/rotate', () => {
  it('returns a new raw API key and meta on success', async () => {
    const { record } = await createApiKey({
      label: 'rotate-me',
      scopes: [ApiScope.ReadVaults],
      userId: 'owner',
    } as any)

    const app = buildApp()
    const res = await request(app)
      .post(`/api/api-keys/${record.id}/rotate`)
      .set('x-mock-user-id', 'owner')

    expect(res.status).toBe(200)
    expect(typeof res.body.apiKey).toBe('string')
    expect(res.body.apiKey).toMatch(/^dsk_/)
    expect(res.body.apiKeyMeta.keyHash).toBeUndefined()
  })

  it('new key is immediately usable for authentication', async () => {
    const { record } = await createApiKey({
      label: 'rotate-auth',
      scopes: [ApiScope.ReadVaults],
      userId: 'owner2',
    } as any)

    const app = buildApp()
    const rotateRes = await request(app)
      .post(`/api/api-keys/${record.id}/rotate`)
      .set('x-mock-user-id', 'owner2')

    expect(rotateRes.status).toBe(200)
    const newApiKey = rotateRes.body.apiKey

    // Validate the new key directly
    const result = await validateApiKey(newApiKey)
    expect(result.valid).toBe(true)
  })

  it('returns 404 when the key does not belong to the requesting user', async () => {
    const { record } = await createApiKey({
      label: 'not-mine',
      scopes: [],
      userId: 'real-owner',
    } as any)

    const app = buildApp()
    const res = await request(app)
      .post(`/api/api-keys/${record.id}/rotate`)
      .set('x-mock-user-id', 'attacker')

    expect(res.status).toBe(404)
  })

  it('returns 404 when the key is already revoked', async () => {
    const { record } = await createApiKey({
      label: 'revoked-rotate',
      scopes: [],
      userId: 'owner3',
    } as any)
    await revokeApiKey(record.id, 'owner3')

    const app = buildApp()
    const res = await request(app)
      .post(`/api/api-keys/${record.id}/rotate`)
      .set('x-mock-user-id', 'owner3')

    expect(res.status).toBe(404)
  })
})

// ── POST /api/api-keys/:id/revoke ─────────────────────────────────────────────

describe('POST /api/api-keys/:id/revoke', () => {
  it('revokes the key and returns meta with revokedAt set', async () => {
    const { record } = await createApiKey({
      label: 'revoke-me',
      scopes: [ApiScope.ReadVaults],
      userId: 'revoke-owner',
    } as any)

    const app = buildApp()
    const res = await request(app)
      .post(`/api/api-keys/${record.id}/revoke`)
      .set('x-mock-user-id', 'revoke-owner')

    expect(res.status).toBe(200)
    expect(res.body.apiKeyMeta.revokedAt).not.toBeNull()
    expect(res.body.apiKeyMeta.keyHash).toBeUndefined()
  })

  it('returns 404 when key belongs to a different user (cross-user revoke)', async () => {
    const { record } = await createApiKey({
      label: 'not-yours',
      scopes: [],
      userId: 'legit-owner',
    } as any)

    const app = buildApp()
    const res = await request(app)
      .post(`/api/api-keys/${record.id}/revoke`)
      .set('x-mock-user-id', 'attacker')

    expect(res.status).toBe(404)
  })

  it('is idempotent: revoking an already-revoked key returns 200 with revokedAt', async () => {
    const { record } = await createApiKey({
      label: 'double-revoke',
      scopes: [],
      userId: 'dr-owner',
    } as any)
    await revokeApiKey(record.id, 'dr-owner')

    const app = buildApp()
    const res = await request(app)
      .post(`/api/api-keys/${record.id}/revoke`)
      .set('x-mock-user-id', 'dr-owner')

    // The key exists and belongs to the user — just already revoked
    expect(res.status).toBe(200)
    expect(res.body.apiKeyMeta.revokedAt).not.toBeNull()
  })
})

// ── authenticateApiKey middleware ─────────────────────────────────────────────

describe('authenticateApiKey middleware', () => {
  function buildApiKeyApp(scopes: ApiScope[] = []) {
    const app = express()
    app.use(express.json())
    app.get('/secured', authenticateApiKey(scopes), (_req, res) => res.json({ ok: true }))
    return app
  }

  it('returns 401 when x-api-key header is absent', async () => {
    const app = buildApiKeyApp()
    const res = await request(app).get('/secured')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/missing api key/i)
  })

  it('returns 401 for a malformed key', async () => {
    const app = buildApiKeyApp()
    const res = await request(app)
      .get('/secured')
      .set('x-api-key', 'not-a-valid-key')
    expect(res.status).toBe(401)
  })

  it('returns 401 for a revoked key', async () => {
    const { apiKey, record } = await createApiKey({
      label: 'middleware-revoke',
      scopes: [ApiScope.ReadVaults],
      userId: 'mw-user',
    } as any)
    await revokeApiKey(record.id, 'mw-user')

    const app = buildApiKeyApp()
    const res = await request(app)
      .get('/secured')
      .set('x-api-key', apiKey)

    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/revoked/i)
  })

  it('returns 403 when the key lacks a required scope', async () => {
    const { apiKey } = await createApiKey({
      label: 'scope-limited',
      scopes: [ApiScope.ReadVaults],
    })

    const app = buildApiKeyApp([ApiScope.WriteVaults])
    const res = await request(app)
      .get('/secured')
      .set('x-api-key', apiKey)

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/required scopes/i)
  })

  it('grants access and sets req.apiKeyAuth for a valid key', async () => {
    const { apiKey, record } = await createApiKey({
      label: 'middleware-valid',
      scopes: [ApiScope.ReadVaults],
      userId: 'mw-owner',
    } as any)

    const app = express()
    app.use(express.json())
    app.get('/secured', authenticateApiKey([ApiScope.ReadVaults]), (req, res) => {
      res.json({ apiKeyId: (req as any).apiKeyAuth?.apiKeyId })
    })

    const res = await request(app)
      .get('/secured')
      .set('x-api-key', apiKey)

    expect(res.status).toBe(200)
    expect(res.body.apiKeyId).toBe(record.id)
  })

  it('grants access when no required scopes are specified', async () => {
    const { apiKey } = await createApiKey({ label: 'any-scope', scopes: [] })

    const app = buildApiKeyApp() // no required scopes
    const res = await request(app)
      .get('/secured')
      .set('x-api-key', apiKey)

    expect(res.status).toBe(200)
  })
})

// ── requireScopes middleware ──────────────────────────────────────────────────

describe('requireScopes middleware', () => {
  function buildRequireScopesApp(...required: ApiScope[]) {
    const app = express()
    app.use(express.json())
    app.get('/route', requireScopes(...required), (_req, res) => res.json({ ok: true }))
    return app
  }

  it('passes through when req.apiKeyAuth is absent (allows JWT-auth path)', async () => {
    const app = buildRequireScopesApp(ApiScope.ReadVaults)
    const res = await request(app).get('/route')
    // No apiKeyAuth = not an API key request → guard is not the gatekeeper
    expect(res.status).toBe(200)
  })

  it('returns 403 when apiKeyAuth is present but lacks the required scope', async () => {
    const app = express()
    app.use(express.json())
    app.get(
      '/route',
      (req, _res, next) => {
        ;(req as any).apiKeyAuth = {
          apiKeyId: 'k1',
          userId: 'u1',
          orgId: null,
          scopes: [ApiScope.ReadVaults],
          label: 'test',
        }
        next()
      },
      requireScopes(ApiScope.WriteVaults),
      (_req, res) => res.json({ ok: true }),
    )

    const res = await request(app).get('/route')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/required scopes/i)
  })

  it('calls next() when apiKeyAuth has at least one of the required scopes', async () => {
    const app = express()
    app.use(express.json())
    app.get(
      '/route',
      (req, _res, next) => {
        ;(req as any).apiKeyAuth = {
          apiKeyId: 'k2',
          userId: 'u2',
          orgId: null,
          scopes: [ApiScope.ReadVaults, ApiScope.ReadAnalytics],
          label: 'test',
        }
        next()
      },
      requireScopes(ApiScope.ReadAnalytics),
      (_req, res) => res.json({ ok: true }),
    )

    const res = await request(app).get('/route')
    expect(res.status).toBe(200)
  })
})

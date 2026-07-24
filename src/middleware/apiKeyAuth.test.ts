import { describe, it, expect, beforeEach } from '@jest/globals'
import { setApiKeyRepositoryForTests, createApiKey, validateApiKey } from '../services/apiKeys.js'
import { randomUUID, createHash } from 'node:crypto'

// Small in-memory repository to observe updates
const makeRepo = () => {
  const store = new Map()
  return {
    async create(record) {
      store.set(record.id, { ...record })
    },
    async listForUser() {
      return Array.from(store.values())
    },
    async getById(id) {
      return store.get(id) ?? null
    },
    async update(record) {
      store.set(record.id, { ...record })
      return store.get(record.id)
    },
    async findByIdForUser(id, _userId) {
      const r = store.get(id)
      return r ?? null
    },
    async findByHashPrefix(prefix) {
      return Array.from(store.values()).filter((r) => r.keyHash.slice(0, 12) === prefix)
    },
    async reset() {
      store.clear()
    },
  }
}

describe('API key hashing (Argon2 migration)', () => {
  beforeEach(() => {
    setApiKeyRepositoryForTests(makeRepo())
  })

  it('creates and validates new argon2 keys', async () => {
    const { apiKey, record } = await createApiKey({ label: 't', scopes: [] })

    const result = await validateApiKey(apiKey)
    expect(result.valid).toBe(true)
    expect(result.context.apiKeyId).toBe(record.id)
    expect(record.keyHash.includes('$argon2id$')).toBe(true)
  })

  it('validates legacy sha256 keys and triggers rolling rehash', async () => {
    const repo = makeRepo()
    setApiKeyRepositoryForTests(repo)

    const secret = 'legacy-secret-123'
    const fingerprint = createHash('sha256').update(secret).digest('hex')
    const id = randomUUID()
    const record = {
      id,
      userId: null,
      orgId: null,
      keyHash: fingerprint,
      label: 'legacy',
      scopes: [],
      createdAt: new Date().toISOString(),
      revokedAt: null,
    }

    await repo.create(record)
    const apiKey = `dsk_${id}.${secret}`

    const validation = await validateApiKey(apiKey)
    expect(validation.valid).toBe(true)

    const updated = await repo.getById(id)
    expect(updated.keyHash.includes('$argon2id$')).toBe(true)
  })
})
import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { authenticateApiKey } from './apiKeyAuth.js'
import { createApiKey, resetApiKeysTable } from '../services/apiKeys.js'

const buildApp = () => {
  const app = express()
  app.get(
    '/protected',
    authenticateApiKey(['read:analytics']),
    (req, res) => {
      res.status(200).json({
        ok: true,
        apiKeyId: req.apiKeyAuth?.apiKeyId ?? null,
        userId: req.apiKeyAuth?.userId ?? null,
      })
    },
  )
  return app
}

test('requires x-api-key when protecting a route', async () => {
  await resetApiKeysTable()
  const app = buildApp()

  const response = await request(app).get('/protected')

  assert.equal(response.status, 401)
  assert.equal(response.body.error, 'Missing API key. Provide x-api-key header.')
})

test('accepts a valid scoped api key', async () => {
  await resetApiKeysTable()
  const app = buildApp()
  const { apiKey, record } = await createApiKey({
    userId: 'user-scope',
    label: 'scoped key',
    scopes: ['read:analytics'],
  })

  const response = await request(app)
    .get('/protected')
    .set('x-api-key', apiKey)

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.apiKeyId, record.id)
  assert.equal(response.body.userId, 'user-scope')
})

test('rejects keys without the required scopes', async () => {
  await resetApiKeysTable()
  const app = buildApp()
  const { apiKey } = await createApiKey({
    userId: 'user-vault-only',
    label: 'vault-only key',
    scopes: ['read:vaults'],
  })

  const response = await request(app)
    .get('/protected')
    .set('x-api-key', apiKey)

  assert.equal(response.status, 403)
  assert.equal(response.body.error, 'API key does not have the required scopes.')
})

test('gives x-api-key precedence over Authorization when both are present', async () => {
  await resetApiKeysTable()
  const app = buildApp()
  const { apiKey } = await createApiKey({
    userId: 'user-good-key',
    label: 'good key',
    scopes: ['read:analytics'],
  })

  const response = await request(app)
    .get('/protected')
    .set('x-api-key', `${apiKey}-tampered`)
    .set('authorization', 'Bearer user:jwt-user')

  assert.equal(response.status, 401)
  assert.equal(response.body.error, 'API key is invalid.')
})

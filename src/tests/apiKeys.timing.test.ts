import { beforeEach, describe, expect, it } from 'bun:test'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'
import {
  constantTimeEqualForTests,
  createApiKey,
  revokeApiKey,
  setApiKeyRepositoryForTests,
  validateApiKey,
} from '../services/apiKeys.js'
import { ApiScope, type ApiKeyRecord } from '../types/auth.js'

const cloneRecord = (record: ApiKeyRecord): ApiKeyRecord => ({
  ...record,
  scopes: [...record.scopes],
})

function makeRepo() {
  const store = new Map<string, ApiKeyRecord>()

  return {
    async create(record: ApiKeyRecord) {
      store.set(record.id, cloneRecord(record))
    },
    async listForUser(userId: string) {
      return Array.from(store.values())
        .filter((record) => record.userId === userId)
        .map(cloneRecord)
    },
    async getById(id: string) {
      const record = store.get(id)
      return record ? cloneRecord(record) : null
    },
    async update(record: ApiKeyRecord) {
      store.set(record.id, cloneRecord(record))
      return cloneRecord(record)
    },
    async findByIdForUser(id: string, userId: string) {
      const record = store.get(id)
      return record && record.userId === userId ? cloneRecord(record) : null
    },
    async findByHashPrefix(prefix: string) {
      return Array.from(store.values())
        .filter((record) => record.keyHash.slice(0, 12) === prefix)
        .map(cloneRecord)
    },
    async reset() {
      store.clear()
    },
  }
}

function buildApp() {
  const app = express()
  app.get('/protected', authenticateApiKey([ApiScope.ReadAnalytics]), (req, res) => {
    res.status(200).json({
      ok: true,
      apiKeyId: req.apiKeyAuth?.apiKeyId,
      userId: req.apiKeyAuth?.userId,
    })
  })
  return app
}

describe('API key timing resistance and uniform failure', () => {
  beforeEach(() => {
    setApiKeyRepositoryForTests(makeRepo())
  })

  it('uses constant-time fingerprint equality without first-mismatch success', () => {
    const expected = 'a'.repeat(64)

    expect(constantTimeEqualForTests(expected, expected)).toBe(true)
    expect(constantTimeEqualForTests(`b${'a'.repeat(63)}`, expected)).toBe(false)
    expect(constantTimeEqualForTests(`${'a'.repeat(63)}b`, expected)).toBe(false)
    expect(constantTimeEqualForTests('a'.repeat(63), expected)).toBe(false)
  })

  it('authenticates valid API keys', async () => {
    const app = buildApp()
    const { apiKey, record } = await createApiKey({
      userId: 'user-valid',
      label: 'valid analytics key',
      scopes: [ApiScope.ReadAnalytics],
    })

    const serviceResult = await validateApiKey(apiKey, [ApiScope.ReadAnalytics])
    expect(serviceResult.valid).toBe(true)

    const response = await request(app).get('/protected').set('x-api-key', apiKey)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      apiKeyId: record.id,
      userId: 'user-valid',
    })
  })

  it('returns one public failure shape for malformed, unknown, and revoked keys', async () => {
    const app = buildApp()
    const { apiKey, record } = await createApiKey({
      userId: 'user-revoked',
      label: 'revoked analytics key',
      scopes: [ApiScope.ReadAnalytics],
    })
    await revokeApiKey(record.id, 'user-revoked')

    const failures = [
      'not-an-api-key',
      `dsk_${randomUUID()}.${'f'.repeat(64)}`,
      apiKey,
    ]

    for (const key of failures) {
      const response = await request(app).get('/protected').set('x-api-key', key)
      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'API key is invalid.' })
    }
  })

  it('keeps scope failures distinct from invalid-key failures', async () => {
    const app = buildApp()
    const { apiKey } = await createApiKey({
      userId: 'user-vaults',
      label: 'vault key',
      scopes: [ApiScope.ReadVaults],
    })

    const response = await request(app).get('/protected').set('x-api-key', apiKey)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'API key does not have the required scopes.' })
  })
})

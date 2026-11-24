import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { ApiScope } from '../types/auth.js'

jest.unstable_mockModule('../db/pool.js', () => ({ getPgPool: () => null }))
jest.unstable_mockModule('../middleware/auth.js', () => ({
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    const userId = req.header('x-user-id')?.trim()
    if (userId) (req as any).authUser = { userId }
    next()
  },
}))
jest.unstable_mockModule('../services/organization.js', () => ({
  getOrganizationById: jest.fn(async (orgId: string) => (orgId === 'org-123' ? { id: orgId } : null)),
}))
jest.unstable_mockModule('../services/membership.js', () => ({
  getOrgMembership: jest.fn(async () => ({ role: 'admin' })),
}))

const { getApiKeyUsageHandler } = await import('../routes/apiKeys.js')
const { resetApiKeysTable, setApiKeyRepositoryForTests, recordApiKeyUsage, flushPendingUpdates } = await import('../services/apiKeys.js')

const makeRepo = () => {
  const store = new Map<string, any>()
  return {
    async create(record: any) { store.set(record.id, { ...record }) },
    async listForUser(userId: string) {
      return Array.from(store.values()).filter((record: any) => record.userId === userId).sort((left: any, right: any) => right.createdAt.localeCompare(left.createdAt))
    },
    async listForOrg(orgId: string) {
      return Array.from(store.values()).filter((record: any) => record.orgId === orgId).sort((left: any, right: any) => right.createdAt.localeCompare(left.createdAt))
    },
    async getById(id: string) { return store.get(id) ?? null },
    async update(record: any) { store.set(record.id, { ...record }); return store.get(record.id) },
    async findByIdForUser(id: string, userId: string) {
      const record: any = store.get(id)
      return record && record.userId === userId ? record : null
    },
    async findByHashPrefix(prefix: string) {
      return Array.from(store.values()).filter((record: any) => record.keyHash.slice(0, 12) === prefix)
    },
    async clearExpiredPrevious() { return 0 },
    async reset() { store.clear() },
  }
}

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.get('/api/orgs/:orgId/api-keys/usage', (req, _res, next) => {
    const userId = req.header('x-user-id')?.trim()
    if (userId) (req as any).authUser = { userId }
    next()
  }, getApiKeyUsageHandler)
  return app
}

beforeEach(async () => {
  setApiKeyRepositoryForTests(makeRepo() as any)
  await resetApiKeysTable()
})

afterEach(async () => {
  await flushPendingUpdates()
  setApiKeyRepositoryForTests(null)
})

describe('API key usage analytics', () => {
  it('records API key usage successfully on authentication', async () => {
    const repo = makeRepo()
    setApiKeyRepositoryForTests(repo as any)
    const apiKeyId = 'key-1'
    await repo.create({
      id: apiKeyId, userId: 'user-admin', orgId: 'org-123', keyHash: 'hash-1',
      label: 'Test Key', scopes: [ApiScope.ReadAnalytics], createdAt: new Date().toISOString(), revokedAt: null,
    })

    recordApiKeyUsage(apiKeyId, '127.0.0.1')
    await flushPendingUpdates()

    const updated = await repo.getById(apiKeyId)
    expect(updated).toBeTruthy()
    expect(updated.requestCount).toBe(1)
    expect(updated.lastIp).toBe('127.0.0.1')
    expect(updated.lastUsedAt).toBeTruthy()
  })

  it('GET /api/orgs/:orgId/api-keys/usage returns usage stats', async () => {
    const repo = makeRepo()
    setApiKeyRepositoryForTests(repo as any)
    const apiKeyId = 'key-3'
    await repo.create({
      id: apiKeyId, userId: 'user-admin', orgId: 'org-123', keyHash: 'somehash',
      label: 'Test Key', scopes: [ApiScope.ReadAnalytics], createdAt: new Date().toISOString(), revokedAt: null,
      lastUsedAt: new Date().toISOString(), requestCount: 5, lastIp: '192.168.1.1',
    })

    const response = await request(buildApp()).get('/api/orgs/org-123/api-keys/usage').set('x-user-id', 'user-admin')

    expect(response.status).toBe(200)
    expect(Array.isArray(response.body.usage)).toBe(true)
    expect(response.body.usage).toHaveLength(1)
    expect(response.body.usage[0].id).toBe(apiKeyId)
    expect(response.body.usage[0].requestCount).toBe(5)
    expect(response.body.usage[0].lastIp).toBe('192.168.1.1')
    expect(response.body.usage[0].keyHash).toBeUndefined()
  })
})
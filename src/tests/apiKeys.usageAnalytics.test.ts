import './setup.js'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, test } from 'node:test'
import express from 'express'
import { requireUserAuth } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { getApiKeyUsageHandler } from '../routes/apiKeys.js'
import {
  resetApiKeysTable,
  setApiKeyRepositoryForTests,
  recordApiKeyUsage,
  flushPendingUpdates,
} from '../services/apiKeys.js'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'
import { ApiScope } from '../types/auth.js'

const makeRepo = () => {
  const store = new Map()
  return {
    async create(record: any) {
      store.set(record.id, { ...record })
    },
    async listForUser(userId: string) {
      return Array.from(store.values())
        .filter((record: any) => record.userId === userId)
        .sort((left: any, right: any) => right.createdAt.localeCompare(left.createdAt))
    },
    async listForOrg(orgId: string) {
      return Array.from(store.values())
        .filter((record: any) => record.orgId === orgId)
        .sort((left: any, right: any) => right.createdAt.localeCompare(left.createdAt))
    },
    async getById(id: string) {
      return store.get(id) ?? null
    },
    async update(record: any) {
      store.set(record.id, { ...record })
      return store.get(record.id)
    },
    async findByIdForUser(id: string, userId: string) {
      const record: any = store.get(id)
      if (!record || record.userId !== userId) {
        return null
      }
      return record
    },
    async findByHashPrefix(prefix: string) {
      return Array.from(store.values()).filter((record: any) => record.keyHash.slice(0, 12) === prefix)
    },
    async reset() {
      store.clear()
    },
  }
}

let baseUrl = ''
let server: ReturnType<express.Express['listen']> | null = null

beforeEach(async () => {
  setApiKeyRepositoryForTests(makeRepo() as any)
  await resetApiKeysTable()

  setOrganizations([{ id: 'org-123', name: 'Test Org', createdAt: new Date().toISOString() }])
  setOrgMembers([
    { orgId: 'org-123', userId: 'user-admin', role: 'admin' },
    { orgId: 'org-123', userId: 'user-member', role: 'member' },
  ])

  const app = express()
  app.use(express.json())
  app.get('/api/orgs/:orgId/api-keys/usage', requireUserAuth, requireOrgAccess('owner', 'admin'), getApiKeyUsageHandler)
  
  server = app.listen(0)
  await new Promise<void>((resolve) => {
    server!.once('listening', () => resolve())
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (server) {
    server.close()
  }
  setApiKeyRepositoryForTests(null)
  setOrganizations([])
  setOrgMembers([])
})

test('records API key usage successfully on authentication', async () => {
  const repo = makeRepo()
  setApiKeyRepositoryForTests(repo as any)

  const apiKeyId = 'key-1'
  const record = {
    id: apiKeyId,
    userId: 'user-admin',
    orgId: 'org-123',
    keyHash: 'hash-1',
    label: 'Test Key',
    scopes: [ApiScope.ReadAnalytics],
    createdAt: new Date().toISOString(),
    revokedAt: null,
  }
  await repo.create(record)

  // Explicitly record usage
  recordApiKeyUsage(apiKeyId, '127.0.0.1')
  await flushPendingUpdates()

  const updated = await repo.getById(apiKeyId)
  assert.ok(updated)
  assert.equal(updated.requestCount, 1)
  assert.equal(updated.lastIp, '127.0.0.1')
  assert.ok(updated.lastUsedAt)
})

test('GET /api/orgs/:orgId/api-keys/usage returns usage stats and restricts access', async () => {
  const repo = makeRepo()
  setApiKeyRepositoryForTests(repo as any)

  const apiKeyId = 'key-3'
  const record = {
    id: apiKeyId,
    userId: 'user-admin',
    orgId: 'org-123',
    keyHash: 'somehash',
    label: 'Test Key',
    scopes: [ApiScope.ReadAnalytics],
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastUsedAt: new Date().toISOString(),
    requestCount: 5,
    lastIp: '192.168.1.1',
  }
  await repo.create(record)

  // 1. Request as org admin (authorized)
  const resAdmin = await fetch(`${baseUrl}/api/orgs/org-123/api-keys/usage`, {
    headers: { 'x-user-id': 'user-admin' },
  })
  assert.equal(resAdmin.status, 200)
  const bodyAdmin = (await resAdmin.json()) as any
  assert.ok(Array.isArray(bodyAdmin.usage))
  assert.equal(bodyAdmin.usage.length, 1)
  assert.equal(bodyAdmin.usage[0].id, apiKeyId)
  assert.equal(bodyAdmin.usage[0].requestCount, 5)
  assert.equal(bodyAdmin.usage[0].lastIp, '192.168.1.1')
  assert.equal(bodyAdmin.usage[0].keyHash, undefined) // Must not leak hash!

  // 2. Request as org member (forbidden - requires owner/admin)
  const resMember = await fetch(`${baseUrl}/api/orgs/org-123/api-keys/usage`, {
    headers: { 'x-user-id': 'user-member' },
  })
  assert.equal(resMember.status, 403)

  // 3. Request as random user (forbidden)
  const resRandom = await fetch(`${baseUrl}/api/orgs/org-123/api-keys/usage`, {
    headers: { 'x-user-id': 'user-random' },
  })
  assert.equal(resRandom.status, 403)
})

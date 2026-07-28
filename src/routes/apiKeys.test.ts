import '../tests/setup.js'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { analyticsRouter } from './analytics.js'
import { apiKeysRouter } from './apiKeys.js'
import { resetApiKeysTable, setApiKeyRepositoryForTests } from '../services/apiKeys.js'
import { setAuditLogWriterForTests } from '../lib/audit-logs.js'
import { AuthService } from '../services/auth.service.js'

let baseUrl = ''
let server: ReturnType<express.Express['listen']> | null = null
const originalValidate = AuthService.validateStepUpSession

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

beforeEach(async () => {
  AuthService.validateStepUpSession = async (sessionId: string) => {
    return { userId: sessionId } as any
  }
  setApiKeyRepositoryForTests(makeRepo() as any)
  setAuditLogWriterForTests(async (entry: any) => {
    return {
      id: 'mock-audit-id',
      created_at: new Date().toISOString(),
      ...entry,
    } as any
  })
  await resetApiKeysTable()
  const app = express()
  app.use(express.json())
  app.use('/api/api-keys', apiKeysRouter)
  app.use('/api/analytics', analyticsRouter)
  server = app.listen(0)
  await new Promise<void>((resolve) => {
    server!.once('listening', () => resolve())
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  AuthService.validateStepUpSession = originalValidate
  if (!server) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    server!.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
  server = null
})

test('creates, lists, rotates, and revokes API keys for an authenticated user', async () => {
  const createResponse = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'user-123',
    },
    body: JSON.stringify({
      label: 'analytics integration',
      scopes: ['read:analytics', 'read:vaults', 'read:analytics'],
    }),
  })

  expect(createResponse.status).toBe(201)
  const createdBody = (await createResponse.json()) as {
    apiKey: string
    apiKeyMeta: { id: string; userId: string; revokedAt: string | null; scopes: string[]; keyHash?: string }
  }

  assert.match(createdBody.apiKey, /^dsk_/)
  expect(createdBody.apiKeyMeta.userId).toBe('user-123')
  expect(createdBody.apiKeyMeta.revokedAt).toBe(null)
  expect(createdBody.apiKeyMeta.scopes).toEqual(['read:analytics', 'read:vaults'])
  expect('keyHash' in createdBody.apiKeyMeta).toBe(false)

  const listResponse = await fetch(`${baseUrl}/api/api-keys`, {
    headers: {
      'x-user-id': 'user-123',
    },
  })

  expect(listResponse.status).toBe(200)
  const listBody = (await listResponse.json()) as {
    apiKeys: Array<{ id: string; keyHash?: string; scopes: string[] }>
  }

  expect(listBody.apiKeys.length).toBe(1)
  expect(listBody.apiKeys[0].id).toBe(createdBody.apiKeyMeta.id)
  expect('keyHash' in listBody.apiKeys[0]).toBe(false)
  expect(listBody.apiKeys[0].scopes).toEqual(['read:analytics', 'read:vaults'])

  const rotateResponse = await fetch(`${baseUrl}/api/api-keys/${createdBody.apiKeyMeta.id}/rotate`, {
    method: 'POST',
    headers: {
      'x-user-id': 'user-123',
    },
  })

  expect(rotateResponse.status).toBe(200)
  const rotateBody = (await rotateResponse.json()) as {
    apiKey: string
    apiKeyMeta: { id: string; revokedAt: string | null; keyHash?: string }
  }

  assert.match(rotateBody.apiKey, /^dsk_/)
  assert.notEqual(rotateBody.apiKey, createdBody.apiKey)
  expect(rotateBody.apiKeyMeta.id).toBe(createdBody.apiKeyMeta.id)
  expect('keyHash' in rotateBody.apiKeyMeta).toBe(false)

  const oldKeyResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': createdBody.apiKey,
    },
  })
  expect(oldKeyResponse.status).toBe(401)

  const newKeyResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': rotateBody.apiKey,
    },
  })
  expect(newKeyResponse.status).toBe(200)

  const revokeResponse = await fetch(`${baseUrl}/api/api-keys/${createdBody.apiKeyMeta.id}/revoke`, {
    method: 'POST',
    headers: {
      'x-user-id': 'user-123',
      'x-step-up-session-id': 'user-123',
    },
  })

  expect(revokeResponse.status).toBe(200)
  const revokeBody = (await revokeResponse.json()) as {
    apiKeyMeta: { revokedAt: string | null }
  }
  assert.notEqual(revokeBody.apiKeyMeta.revokedAt, null)

  const revokedResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': rotateBody.apiKey,
    },
  })
  expect(revokedResponse.status).toBe(401)
})

test('rejects rotation for keys owned by a different user', async () => {
  const createResponse = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'owner-user',
    },
    body: JSON.stringify({
      label: 'owner key',
      scopes: ['read:analytics'],
    }),
  })

  const createdBody = (await createResponse.json()) as { apiKeyMeta: { id: string } }

  const rotateResponse = await fetch(`${baseUrl}/api/api-keys/${createdBody.apiKeyMeta.id}/rotate`, {
    method: 'POST',
    headers: {
      'x-user-id': 'other-user',
    },
  })

  expect(rotateResponse.status).toBe(404)
})

test('validates scopes and rejects revoked API keys on protected analytics routes', async () => {
  const createResponse = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'user-321',
    },
    body: JSON.stringify({
      label: 'vault-reader',
      scopes: ['read:vaults'],
    }),
  })

  expect(createResponse.status).toBe(201)
  const createdBody = (await createResponse.json()) as {
    apiKey: string
    apiKeyMeta: { id: string }
  }

  const forbiddenResponse = await fetch(`${baseUrl}/api/analytics/overview`, {
    headers: {
      'x-api-key': createdBody.apiKey,
    },
  })
  expect(forbiddenResponse.status).toBe(403)

  const allowedResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': createdBody.apiKey,
    },
  })
  expect(allowedResponse.status).toBe(200)

  await fetch(`${baseUrl}/api/api-keys/${createdBody.apiKeyMeta.id}/revoke`, {
    method: 'POST',
    headers: {
      'x-user-id': 'user-321',
      'x-step-up-session-id': 'user-321',
    },
  })

  const revokedResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': createdBody.apiKey,
    },
  })
  expect(revokedResponse.status).toBe(401)
})

test('returns structured validation errors for invalid API key create payloads', async () => {
  const response = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'user-456',
    },
    body: JSON.stringify({
      label: '   ',
      scopes: ['read:vaults', ''],
    }),
  })

  expect(response.status).toBe(400)
  const body = (await response.json()) as {
    error: {
      code: string
      message: string
      fields: Array<{ path: string; message: string; code: string }>
    }
  }

  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.message).toBe('Invalid request payload')
  expect(body.error.fields.some((field) => field.path === 'label')).toBe(true)
  expect(body.error.fields.some((field) => field.path === 'scopes[1]')).toBe(true)
})

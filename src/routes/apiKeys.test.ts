import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, test } from 'node:test'
import express from 'express'
import { analyticsRouter } from './analytics.js'
import { apiKeysRouter } from './apiKeys.js'
import { resetApiKeysTable } from '../services/apiKeys.js'

let baseUrl = ''
let server: ReturnType<express.Express['listen']> | null = null

beforeEach(async () => {
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

  assert.equal(createResponse.status, 201)
  const createdBody = (await createResponse.json()) as {
    apiKey: string
    apiKeyMeta: { id: string; userId: string; revokedAt: string | null; scopes: string[]; keyHash?: string }
  }

  assert.match(createdBody.apiKey, /^dsk_/)
  assert.equal(createdBody.apiKeyMeta.userId, 'user-123')
  assert.equal(createdBody.apiKeyMeta.revokedAt, null)
  assert.deepEqual(createdBody.apiKeyMeta.scopes, ['read:analytics', 'read:vaults'])
  assert.equal('keyHash' in createdBody.apiKeyMeta, false)

  const listResponse = await fetch(`${baseUrl}/api/api-keys`, {
    headers: {
      'x-user-id': 'user-123',
    },
  })

  assert.equal(listResponse.status, 200)
  const listBody = (await listResponse.json()) as {
    apiKeys: Array<{ id: string; keyHash?: string; scopes: string[] }>
  }

  assert.equal(listBody.apiKeys.length, 1)
  assert.equal(listBody.apiKeys[0].id, createdBody.apiKeyMeta.id)
  assert.equal('keyHash' in listBody.apiKeys[0], false)
  assert.deepEqual(listBody.apiKeys[0].scopes, ['read:analytics', 'read:vaults'])

  const rotateResponse = await fetch(`${baseUrl}/api/api-keys/${createdBody.apiKeyMeta.id}/rotate`, {
    method: 'POST',
    headers: {
      'x-user-id': 'user-123',
    },
  })

  assert.equal(rotateResponse.status, 200)
  const rotateBody = (await rotateResponse.json()) as {
    apiKey: string
    apiKeyMeta: { id: string; revokedAt: string | null; keyHash?: string }
  }

  assert.match(rotateBody.apiKey, /^dsk_/)
  assert.notEqual(rotateBody.apiKey, createdBody.apiKey)
  assert.equal(rotateBody.apiKeyMeta.id, createdBody.apiKeyMeta.id)
  assert.equal('keyHash' in rotateBody.apiKeyMeta, false)

  const oldKeyResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': createdBody.apiKey,
    },
  })
  assert.equal(oldKeyResponse.status, 401)

  const newKeyResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': rotateBody.apiKey,
    },
  })
  assert.equal(newKeyResponse.status, 200)

  const revokeResponse = await fetch(`${baseUrl}/api/api-keys/${createdBody.apiKeyMeta.id}/revoke`, {
    method: 'POST',
    headers: {
      'x-user-id': 'user-123',
    },
  })

  assert.equal(revokeResponse.status, 200)
  const revokeBody = (await revokeResponse.json()) as {
    apiKeyMeta: { revokedAt: string | null }
  }
  assert.notEqual(revokeBody.apiKeyMeta.revokedAt, null)

  const revokedResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': rotateBody.apiKey,
    },
  })
  assert.equal(revokedResponse.status, 401)
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

  assert.equal(rotateResponse.status, 404)
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

  assert.equal(createResponse.status, 201)
  const createdBody = (await createResponse.json()) as {
    apiKey: string
    apiKeyMeta: { id: string }
  }

  const forbiddenResponse = await fetch(`${baseUrl}/api/analytics/overview`, {
    headers: {
      'x-api-key': createdBody.apiKey,
    },
  })
  assert.equal(forbiddenResponse.status, 403)

  const allowedResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': createdBody.apiKey,
    },
  })
  assert.equal(allowedResponse.status, 200)

  await fetch(`${baseUrl}/api/api-keys/${createdBody.apiKeyMeta.id}/revoke`, {
    method: 'POST',
    headers: {
      'x-user-id': 'user-321',
    },
  })

  const revokedResponse = await fetch(`${baseUrl}/api/analytics/vaults`, {
    headers: {
      'x-api-key': createdBody.apiKey,
    },
  })
  assert.equal(revokedResponse.status, 401)
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

  assert.equal(response.status, 400)
  const body = (await response.json()) as {
    error: {
      code: string
      message: string
      fields: Array<{ path: string; message: string; code: string }>
    }
  }

  assert.equal(body.error.code, 'VALIDATION_ERROR')
  assert.equal(body.error.message, 'Invalid request payload')
  assert.equal(body.error.fields.some((field) => field.path === 'label'), true)
  assert.equal(body.error.fields.some((field) => field.path === 'scopes[1]'), true)
})

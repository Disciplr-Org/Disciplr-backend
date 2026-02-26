import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, test } from 'node:test'
import { app } from '../app.js'
import { resetApiKeysTable } from '../services/apiKeys.js'

let baseUrl = ''
let server: ReturnType<typeof app.listen> | null = null

beforeEach(async () => {
  resetApiKeysTable()
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

test('creates, lists, and revokes API keys for an authenticated user', async () => {
  const createResponse = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'user-123',
    },
    body: JSON.stringify({
      label: 'analytics integration',
      scopes: ['read:analytics', 'read:vaults'],
    }),
  })

  assert.equal(createResponse.status, 201)
  const createdBody = (await createResponse.json()) as {
    apiKey: string
    apiKeyMeta: { id: string; userId: string; revokedAt: string | null }
  }

  assert.match(createdBody.apiKey, /^dsk_/)
  assert.equal(createdBody.apiKeyMeta.userId, 'user-123')
  assert.equal(createdBody.apiKeyMeta.revokedAt, null)

  const listResponse = await fetch(`${baseUrl}/api/api-keys`, {
    headers: {
      'x-user-id': 'user-123',
    },
  })

  assert.equal(listResponse.status, 200)
  const listBody = (await listResponse.json()) as {
    apiKeys: Array<{ id: string; keyHash?: string }>
  }

  assert.equal(listBody.apiKeys.length, 1)
  assert.equal(listBody.apiKeys[0].id, createdBody.apiKeyMeta.id)
  assert.equal('keyHash' in listBody.apiKeys[0], false)

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
}
)

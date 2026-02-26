import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, test } from 'node:test'
import { app } from '../app.js'
import { resetIdempotencyStore } from '../services/idempotency.js'
import { resetVaultStore } from '../services/vaultStore.js'

let baseUrl = ''
let server: ReturnType<typeof app.listen> | null = null

const stellar = (): string => `G${'A'.repeat(55)}`

const validPayload = () => ({
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: stellar(),
  destinations: {
    success: stellar(),
    failure: stellar(),
  },
  milestones: [
    {
      title: 'Kickoff',
      dueDate: '2030-02-01T00:00:00.000Z',
      amount: '300',
    },
    {
      title: 'Final review',
      dueDate: '2030-05-01T00:00:00.000Z',
      amount: '700',
    },
  ],
})

beforeEach(async () => {
  resetVaultStore()
  resetIdempotencyStore()

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
    server!.close((error?: Error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

  server = null
})

test('rejects invalid vault payload', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...validPayload(),
      amount: '-1',
    }),
  })

  assert.equal(response.status, 400)
  const body = (await response.json()) as { details: string[] }
  assert.equal(body.details.some((detail) => detail.includes('amount must be a positive number')), true)
})

test('creates vault and returns client-sign payload', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(validPayload()),
  })

  assert.equal(response.status, 201)
  const body = (await response.json()) as {
    vault: { id: string; milestones: Array<{ id: string }> }
    onChain: { payload: { method: string } }
  }

  assert.ok(body.vault.id)
  assert.equal(body.vault.milestones.length, 2)
  assert.equal(body.onChain.payload.method, 'create_vault')
})

test('replays idempotent request and blocks hash mismatch reuse', async () => {
  const idempotencyKey = 'idem-vault-create-1'

  const firstResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(validPayload()),
  })

  assert.equal(firstResponse.status, 201)

  const secondResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(validPayload()),
  })

  assert.equal(secondResponse.status, 200)
  const secondBody = (await secondResponse.json()) as { idempotency: { replayed: boolean } }
  assert.equal(secondBody.idempotency.replayed, true)

  const conflictResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      ...validPayload(),
      amount: '999',
    }),
  })

  assert.equal(conflictResponse.status, 409)
})

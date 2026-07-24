import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, test } from 'node:test'
import express from 'express'

process.env.JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'fallback-access-secret'
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'fallback-access-secret'

const { vaultsRouter } = await import('../routes/vaults.js')
const { errorHandler } = await import('../middleware/errorHandler.js')
const { resetIdempotencyStore, setIdempotencyTtlMs } = await import('../services/idempotency.js')
const { resetVaultStore, listVaults } = await import('../services/vaultStore.js')
const { generateAccessToken } = await import('../lib/auth-utils.js')
const { UserRole } = await import('../types/user.js')

const testApp = express()
testApp.use(express.json())
testApp.use('/api/vaults', vaultsRouter)
testApp.use(errorHandler)

const authToken = generateAccessToken({ userId: 'idempotency-test-user', role: UserRole.USER as UserRole })

let baseUrl = ''
let server: ReturnType<typeof testApp.listen> | null = null

const stellar = (): string => 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB'

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

const postVault = async (payload: ReturnType<typeof validPayload>, idempotencyKey: string) => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken}`,
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  })

  const body = await response.json() as { vault?: { id: string }; idempotency?: { replayed?: boolean }; error?: { code: string } }
  return { response, body }
}

beforeEach(async () => {
  resetVaultStore()
  resetIdempotencyStore()
  setIdempotencyTtlMs(60_000)

  server = testApp.listen(0)
  await new Promise<void>((resolve) => {
    server!.once('listening', () => resolve())
  })

  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (!server) return

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
  setIdempotencyTtlMs(60 * 60 * 1000)
})

describe('vault creation idempotency conflicts', () => {
  test('creates a single vault when two concurrent requests share the same idempotency key', async () => {
    const idempotencyKey = 'parallel-vault-create'

    const [first, second] = await Promise.all([
      postVault(validPayload(), idempotencyKey),
      postVault(validPayload(), idempotencyKey),
    ])

    assert.equal(first.response.status, 201)
    assert.equal(second.response.status, 200)
    assert.equal(first.body.vault?.id, second.body.vault?.id)
    assert.equal(first.body.idempotency?.replayed, false)
    assert.equal(second.body.idempotency?.replayed, true)

    const vaults = await listVaults()
    assert.equal(vaults.length, 1)
  })

  test('returns 409 conflict when the same key is reused with a different payload', async () => {
    const idempotencyKey = 'conflicting-vault-create'

    const first = await postVault(validPayload(), idempotencyKey)
    assert.equal(first.response.status, 201)

    const second = await postVault({ ...validPayload(), amount: '999' }, idempotencyKey)
    assert.equal(second.response.status, 409)
    assert.equal(second.body.error?.code, 'IDEMPOTENCY_CONFLICT')

    const vaults = await listVaults()
    assert.equal(vaults.length, 1)
  })

  test('allows the key to be reused after TTL eviction without returning stale results', async () => {
    setIdempotencyTtlMs(25)

    const first = await postVault(validPayload(), 'ttl-vault-create')
    assert.equal(first.response.status, 201)

    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = await postVault(validPayload(), 'ttl-vault-create')
    assert.equal(second.response.status, 201)
    assert.equal(second.body.idempotency?.replayed, false)
    assert.notEqual(second.body.vault?.id, first.body.vault?.id)

    const vaults = await listVaults()
    assert.equal(vaults.length, 2)
  })
})

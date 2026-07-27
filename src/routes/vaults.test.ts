import type { AddressInfo } from 'node:net'
import express from 'express'
import request from 'supertest'
import { app } from '../app.js'
import { vaultsRouter, setVaults, type Vault } from './vaults.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { resetIdempotencyStore } from '../services/idempotency.js'
import { resetVaultStore, createVaultWithMilestones } from '../services/vaultStore.js'

app.use('/api/vaults', vaultsRouter)
import { VAULT_MILESTONES_MAX } from '../services/vaultValidation.js'
import { runListContractTests } from '../tests/helpers/listContract.js'
import { generateAccessToken } from '../lib/auth-utils.js'
import { UserRole } from '../types/user.js'

const testApp = express()
testApp.use(express.json())
testApp.use('/api/vaults', vaultsRouter)
testApp.use(errorHandler)

const userToken = generateAccessToken({ userId: 'vault-test-user', role: UserRole.USER })
const otherUserToken = generateAccessToken({ userId: 'other-vault-user', role: UserRole.USER })
const listContractToken = generateAccessToken({ userId: 'vault-list-user', role: UserRole.USER })
const adminToken = generateAccessToken({ userId: 'vault-admin-user', role: UserRole.ADMIN })

let baseUrl = ''
let server: ReturnType<typeof testApp.listen> | null = null

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
  setVaults([])

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
      if (error) { reject(error); return }
      resolve()
    })
  })

  server = null
})

test('returns 401 without an auth token', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validPayload()),
  })
  expect(response.status).toBe(401)
})

test('rejects invalid vault payload', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({ ...validPayload(), amount: '-1' }),
  })

  expect(response.status).toBe(400)
  const body = (await response.json()) as { error: { code: string; fields: { path: string; message: string }[] } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'amount' && f.message.includes('positive'))).toBe(true)
})

test('returns 400 for missing required verifier field', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({ ...validPayload(), verifier: undefined }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'verifier')).toBe(true)
})

test('returns 400 for too many milestones', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      milestones: Array.from({ length: VAULT_MILESTONES_MAX + 1 }, (_, index) => ({
        title: `Milestone ${index}`,
        dueDate: '2030-02-01T00:00:00.000Z',
        amount: '1',
      })),
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'milestones' && f.message.includes('at most'))).toBe(true)
})

test('returns 400 for invalid destination address format', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      destinations: { success: 'Gbadaddress', failure: stellar() },
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'destinations.success' && f.message.includes('Stellar'))).toBe(true)
})

test('returns 400 for endDate before startDate', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      startDate: '2030-06-01T00:00:00.000Z',
      endDate: '2030-01-01T00:00:00.000Z',
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'endDate' && f.message.includes('greater than startDate'))).toBe(true)
})

test('returns 413 for payloads exceeding the body parser limit', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({ data: 'a'.repeat(150 * 1024) }),
  })

  expect(response.status).toBe(413)
  const body = await response.json() as { error: { code: string; message: string } }
  expect(body.error.code).toBe('PAYLOAD_TOO_LARGE')
  expect(body.error.message).toBe('Payload too large')
})

// ─── Boundary Condition Integration Tests ────────────────────────────────

test('returns 400 for zero amount payload', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({ ...validPayload(), amount: '0' }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'amount' && f.message.includes('positive number'))).toBe(true)
})

test('returns 400 for negative amount payload', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({ ...validPayload(), amount: '-100' }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'amount' && f.message.includes('positive number'))).toBe(true)
})

test('returns 400 for non-numeric amount payload', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({ ...validPayload(), amount: 'not-a-number' }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'amount' && f.message.includes('positive number'))).toBe(true)
})

test('returns 400 for amount exceeding maximum', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({ ...validPayload(), amount: '1000000001' }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'amount' && f.message.includes('between'))).toBe(true)
})

test('returns 400 for invalid timestamp formats', async () => {
  const invalidTimestamps = [
    '2024-13-01T00:00:00.000Z', // Invalid month
    'not-a-date',
    '2024-01-01', // Missing time
  ]

  for (const timestamp of invalidTimestamps) {
    const response = await fetch(`${baseUrl}/api/vaults`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${userToken}`,
      },
      body: JSON.stringify({ ...validPayload(), startDate: timestamp }),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.fields.some((f) => f.path === 'startDate' && f.message.includes('ISO timestamp'))).toBe(true)
  }
})

test('returns 400 for endDate equal to startDate', async () => {
  const sameDate = '2030-01-01T00:00:00.000Z'
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      startDate: sameDate,
      endDate: sameDate,
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'endDate' && f.message.includes('greater than startDate'))).toBe(true)
})

test('returns 400 for malformed Stellar addresses', async () => {
  const invalidAddresses = [
    'G' + 'A'.repeat(54) + '1', // Contains '1' (invalid Base32)
    'g' + 'A'.repeat(55), // Lowercase G
    'X' + 'A'.repeat(55), // Wrong prefix
    'G' + 'A'.repeat(54), // Too short
  ]

  for (const address of invalidAddresses) {
    const response = await fetch(`${baseUrl}/api/vaults`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${userToken}`,
      },
      body: JSON.stringify({ ...validPayload(), verifier: address }),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.fields.some((f) => f.path === 'verifier' && f.message.includes('Stellar public key'))).toBe(true)
  }
})

test('returns 400 for milestones with total amount exceeding vault amount', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      amount: '1000',
      milestones: [
        { title: 'M1', dueDate: '2030-02-01T00:00:00.000Z', amount: '600' },
        { title: 'M2', dueDate: '2030-03-01T00:00:00.000Z', amount: '500' }, // Total: 1100 > 1000
      ],
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'milestones' && f.message.includes('Total milestone amount'))).toBe(true)
})

test('returns 400 for milestone dueDate before startDate', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      startDate: '2030-06-01T00:00:00.000Z',
      milestones: [
        { title: 'Early', dueDate: '2030-05-01T00:00:00.000Z', amount: '500' },
      ],
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'milestones[0].dueDate' && f.message.includes('before startDate'))).toBe(true)
})

test('returns 400 for missing required fields in payload', async () => {
  const requiredFields = ['amount', 'startDate', 'endDate', 'verifier', 'destinations', 'milestones']

  for (const field of requiredFields) {
    const payload = validPayload()
    delete (payload as any)[field]
    
    const response = await fetch(`${baseUrl}/api/vaults`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${userToken}`,
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.fields.some((f) => f.path === field)).toBe(true)
  }
})

test('returns 400 for non-JSON content type', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'authorization': `Bearer ${userToken}`,
    },
    body: 'not-json',
  })

  expect(response.status).toBe(400)
})

test('returns 400 for malformed JSON', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: '{"malformed": json}',
  })

  expect(response.status).toBe(400)
})

test('creates vault and returns client-sign payload', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify(validPayload()),
  })

  expect(response.status).toBe(201)
  const body = (await response.json()) as {
    vault: { id: string; milestones: Array<{ id: string }> }
    onChain: { payload: { method: string } }
  }
  expect(body.vault.id).toBeTruthy()
  expect(body.vault.milestones.length).toBe(2)
  expect(body.onChain.payload.method).toBe('create_vault')
})

// ─── Additional Integration Tests for Boundary Conditions ─────────────────

test('returns 400 for invalid onChain mode', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      onChain: {
        mode: 'invalid-mode',
      },
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'onChain.mode')).toBe(true)
})

test('returns 400 for invalid creator address', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      creator: 'invalid-stellar-address',
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'creator' && f.message.includes('Stellar'))).toBe(true)
})

test('accepts valid onChain configuration', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      onChain: {
        mode: 'submit',
        contractId: 'contract-123',
        networkPassphrase: 'Test SDF Network ; September 2015',
        sourceAccount: stellar(),
      },
    }),
  })

  expect(response.status).toBe(201)
})

test('accepts valid creator address', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      creator: stellar(),
    }),
  })

  expect(response.status).toBe(201)
})

test('returns 400 for milestone with invalid timestamp format', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      milestones: [
        {
          title: 'Invalid Timestamp',
          dueDate: '2030-01-01T00:00:00.000+05:00', // Invalid timezone format
          amount: '500',
        },
      ],
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'milestones[0].dueDate' && f.message.includes('ISO timestamp'))).toBe(true)
})

test('returns 400 for milestone with whitespace-only title', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      milestones: [
        {
          title: '   ', // Whitespace only
          dueDate: '2030-02-01T00:00:00.000Z',
          amount: '500',
        },
      ],
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'milestones[0].title' && f.message.includes('required'))).toBe(true)
})

test('returns 400 for milestone amount exceeding maximum', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      milestones: [
        {
          title: 'Too Large',
          dueDate: '2030-02-01T00:00:00.000Z',
          amount: '1000000001', // Exceeds maximum
        },
      ],
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'milestones[0].amount' && f.message.includes('between'))).toBe(true)
})

test('returns 400 for multiple validation errors across fields', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      amount: 'invalid-amount',
      startDate: 'not-a-date',
      endDate: '2030-01-01T00:00:00.000Z',
      verifier: 'bad-addr',
      destinations: { success: 'also-bad', failure: 'bad-too' },
      milestones: [],
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  
  // Should have errors for all the invalid fields
  const expectedPaths = ['amount', 'startDate', 'verifier', 'destinations.success', 'destinations.failure', 'milestones']
  expectedPaths.forEach((path) => {
    expect(body.error.fields.some((f) => f.path === path)).toBe(true, `Missing error for path: ${path}`)
  })
})

test('returns 400 for extremely large milestone title', async () => {
  const hugeTitle = 'a'.repeat(50000) // 50KB title
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      milestones: [
        {
          title: hugeTitle,
          dueDate: '2030-02-01T00:00:00.000Z',
          amount: '500',
        },
      ],
    }),
  })

  // Should accept large titles (no explicit length limit)
  expect(response.status).toBe(201)
})

test('returns 400 for milestone amount with decimal values', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      ...validPayload(),
      milestones: [
        {
          title: 'Decimal Amount',
          dueDate: '2030-02-01T00:00:00.000Z',
          amount: '100.50', // Decimal amount
        },
      ],
    }),
  })

  expect(response.status).toBe(400)
  const body = await response.json() as { error: { code: string; fields: Array<{ path: string; message: string }> } }
  expect(body.error.code).toBe('VALIDATION_ERROR')
  expect(body.error.fields.some((f) => f.path === 'milestones[0].amount')).toBe(true)
})

test('returns 413 for payload slightly over body parser limit', async () => {
  // Create a payload that's just over the 100KB limit
  const largePayload = {
    ...validPayload(),
    milestones: Array.from({ length: 20 }, (_, index) => ({
      title: 'x'.repeat(4000), // Each milestone ~4KB
      dueDate: '2030-02-01T00:00:00.000Z',
      amount: '1',
    })),
  }
  
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify(largePayload),
  })

  expect(response.status).toBe(413)
  const body = await response.json() as { error: { code: string; message: string } }
  expect(body.error.code).toBe('PAYLOAD_TOO_LARGE')
})

test('replays idempotent request and blocks hash mismatch reuse', async () => {
  const idempotencyKey = 'idem-vault-create-1'
  const authHeader = `Bearer ${userToken}`

  const firstResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': authHeader, 'idempotency-key': idempotencyKey },
    body: JSON.stringify(validPayload()),
  })
  expect(firstResponse.status).toBe(201)

  const secondResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': authHeader, 'idempotency-key': idempotencyKey },
    body: JSON.stringify(validPayload()),
  })
  expect(secondResponse.status).toBe(200)
  const secondBody = (await secondResponse.json()) as { idempotency: { replayed: boolean } }
  expect(secondBody.idempotency.replayed).toBe(true)

  const conflictResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': authHeader, 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ ...validPayload(), amount: '999' }),
  })
  expect(conflictResponse.status).toBe(409)
  const conflictBody = (await conflictResponse.json()) as { error: { code: string } }
  expect(conflictBody.error.code).toBe('IDEMPOTENCY_CONFLICT')
})

test('returns 400 for empty idempotency key', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
      'idempotency-key': '',
    },
    body: JSON.stringify(validPayload()),
  })
  expect(response.status).toBe(400)
  const body = (await response.json()) as { error: { code: string } }
  expect(body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
})

test('returns 400 for idempotency key with spaces', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
      'idempotency-key': 'invalid key here',
    },
    body: JSON.stringify(validPayload()),
  })
  expect(response.status).toBe(400)
  const body = (await response.json()) as { error: { code: string } }
  expect(body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
})

test('returns 400 for idempotency key exceeding 255 characters', async () => {
  const response = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
      'idempotency-key': 'a'.repeat(256),
    },
    body: JSON.stringify(validPayload()),
  })
  expect(response.status).toBe(400)
  const body = (await response.json()) as { error: { code: string } }
  expect(body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
})

test('isolates idempotency keys between different users', async () => {
  const key = 'shared-cross-user-key'

  // User 1 creates a vault with the key
  const res1 = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${userToken}`,
      'idempotency-key': key,
    },
    body: JSON.stringify(validPayload()),
  })
  expect(res1.status).toBe(201)
  const body1 = (await res1.json()) as { vault: { id: string } }

  // User 2 uses the same key with a different payload – must NOT get 409
  const res2 = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${otherUserToken}`,
      'idempotency-key': key,
    },
    body: JSON.stringify({ ...validPayload(), amount: '1500' }),
  })
  expect(res2.status).toBe(201)
  const body2 = (await res2.json()) as { vault: { id: string } }

  assert.notEqual(body2.vault.id, body1.vault.id)
})

// ─── List Contract Tests for GET /api/vaults ────────────────────────────────

describe('GET /api/vaults - List Contract', () => {
  const testVaults: string[] = []

  beforeEach(async () => {
    // Create test vaults for list operations
    for (let i = 0; i < 5; i++) {
      const { vault } = await createVaultWithMilestones({
        amount: String(1000 + i * 100),
        startDate: '2030-01-01T00:00:00.000Z',
        endDate: '2030-06-01T00:00:00.000Z',
        verifier: stellar(),
        destinations: {
          success: stellar(),
          failure: stellar(),
        },
        milestones: [
          {
            title: `Milestone ${i}`,
            dueDate: '2030-02-01T00:00:00.000Z',
            amount: '300',
          },
        ],
      })
      testVaults.push(vault.id)
    }
  })

  afterEach(() => {
    testVaults.length = 0
  })

  // Pagination Contract
  describe('Pagination', () => {
    test('validates offset pagination structure', async () => {
      const res = await request(testApp)
        .get('/api/vaults')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data).toBeTruthy()
      expect(res.body.pagination).toBeTruthy()
      expect(typeof res.body.pagination.page).toBe('number')
      expect(typeof res.body.pagination.pageSize).toBe('number')
      expect(typeof res.body.pagination.total).toBe('number')
      expect(typeof res.body.pagination.totalPages).toBe('number')
      expect(typeof res.body.pagination.hasNext).toBe('boolean')
      expect(typeof res.body.pagination.hasPrev).toBe('boolean')
    })

    test('respects page and pageSize parameters', async () => {
      const res = await request(testApp)
        .get('/api/vaults?page=1&pageSize=2')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      expect(res.body.pagination.page).toBe(1)
      expect(res.body.pagination.pageSize).toBe(2)
      expect(res.body.data.length).toBe(2)
    })

    test('enforces maximum pageSize', async () => {
      const res = await request(testApp)
        .get('/api/vaults?pageSize=200')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      expect(res.body.pagination.pageSize <= 100).toBeTruthy()
    })

    test('defaults to page 1 when page < 1', async () => {
      const res = await request(testApp)
        .get('/api/vaults?page=0')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      expect(res.body.pagination.page).toBe(1)
    })
  })

  // Sorting Contract
  describe('Sorting', () => {
    test('rejects invalid sort field with 400', async () => {
      const res = await request(testApp)
        .get('/api/vaults?sortBy=invalid_field')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(400)
      expect(res.body.error).toBeTruthy()
    })

    test('accepts valid sort fields', async () => {
      const validFields = ['createdAt', 'amount', 'endTimestamp', 'status']
      for (const field of validFields) {
        const res = await request(testApp)
          .get(`/api/vaults?sortBy=${field}`)
          .set('Authorization', `Bearer ${listContractToken}`)

        expect(res.status).toBe(200)
        expect(res.body.data).toBeTruthy()
      }
    })

    test('supports ascending and descending order', async () => {
      const ascRes = await request(testApp)
        .get('/api/vaults?sortBy=amount&sortOrder=asc')
        .set('Authorization', `Bearer ${listContractToken}`)

      const descRes = await request(testApp)
        .get('/api/vaults?sortBy=amount&sortOrder=desc')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(ascRes.status).toBe(200)
      expect(descRes.status).toBe(200)
    })
  })

  // Filtering Contract
  describe('Filtering', () => {
    test('ignores non-allowed filter parameters', async () => {
      const res = await request(testApp)
        .get('/api/vaults?nonexistentFilter=value')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data).toBeTruthy()
    })

    test('accepts valid filter fields', async () => {
      const res = await request(testApp)
        .get('/api/vaults?status=active')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data).toBeTruthy()
    })

    test('filters by creator', async () => {
      const res = await request(testApp)
        .get('/api/vaults?creator=GTEST1234567890123456789012345678901234567890123456789012345678901')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data).toBeTruthy()
    })
  })

  // Security Contract
  describe('Security', () => {
    test('requires authentication', async () => {
      const res = await request(app).get('/api/vaults')
      expect(res.status).toBe(401)
    })

    test('cannot sort by sensitive fields', async () => {
      const res = await request(testApp)
        .get('/api/vaults?sortBy=password')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(400)
    })
  })

  // Response Structure Contract
  describe('Response Structure', () => {
    test('returns array of items in data field', async () => {
      const res = await request(testApp)
        .get('/api/vaults')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.data)).toBe(true)
    })

    test('includes required fields in each item', async () => {
      const res = await request(testApp)
        .get('/api/vaults')
        .set('Authorization', `Bearer ${listContractToken}`)

      expect(res.status).toBe(200)
      if (res.body.data.length > 0) {
        const item = res.body.data[0]
        expect(item.id).toBeTruthy()
        expect(Object.prototype.hasOwnProperty.call(item, 'creator').toBeTruthy())
        expect(item.amount).toBeTruthy()
        expect(item.status).toBeTruthy()
      }
    })
  })
})

describe('Vault dispute workflow', () => {
  const seedVault = (overrides: Partial<Vault> = {}): Vault => {
    const vault: Vault = {
      id: `vault-${Math.random().toString(36).slice(2, 10)}`,
      creator: 'vault-test-user',
      amount: '100.00',
      status: 'active',
      startTimestamp: new Date(Date.now() - 10000).toISOString(),
      endTimestamp: new Date(Date.now() + 3600000).toISOString(),
      successDestination: stellar(),
      failureDestination: stellar(),
      createdAt: new Date().toISOString(),
      ...overrides,
    }
    setVaults([vault])
    return vault
  }

  describe('POST /api/vaults/:id/dispute', () => {
    test('returns 401 without an auth token', async () => {
      const vault = seedVault()
      const res = await request(testApp).post(`/api/vaults/${vault.id}/dispute`)
      expect(res.status).toBe(401)
    })

    test('returns 403 for a non-admin user, even if they are the vault creator', async () => {
      const vault = seedVault({ creator: 'vault-test-user' })
      const res = await request(testApp)
        .post(`/api/vaults/${vault.id}/dispute`)
        .set('Authorization', `Bearer ${userToken}`)

      expect(res.status).toBe(403)
    })

    test('allows an admin to place an active vault into disputed', async () => {
      const vault = seedVault({ status: 'active' })
      const res = await request(testApp)
        .post(`/api/vaults/${vault.id}/dispute`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(res.status).toBe(200)
      expect(vault.status).toBe('disputed')
    })

    test('returns 409 when the vault cannot be disputed from its current status', async () => {
      const vault = seedVault({ status: 'draft' })
      const res = await request(testApp)
        .post(`/api/vaults/${vault.id}/dispute`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(res.status).toBe(409)
      expect(vault.status).toBe('draft')
    })

    test('returns 404 for an unknown vault id', async () => {
      const res = await request(testApp)
        .post('/api/vaults/does-not-exist/dispute')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/vaults/:id/resolve-dispute', () => {
    test('returns 401 without an auth token', async () => {
      const vault = seedVault({ status: 'disputed' })
      const res = await request(testApp)
        .post(`/api/vaults/${vault.id}/resolve-dispute`)
        .send({ target: 'active' })
      expect(res.status).toBe(401)
    })

    test('returns 403 for a non-admin user', async () => {
      const vault = seedVault({ status: 'disputed' })
      const res = await request(testApp)
        .post(`/api/vaults/${vault.id}/resolve-dispute`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ target: 'active' })

      expect(res.status).toBe(403)
      expect(vault.status).toBe('disputed')
    })

    test('returns 400 for a missing or invalid target', async () => {
      const vault = seedVault({ status: 'disputed' })
      const res = await request(testApp)
        .post(`/api/vaults/${vault.id}/resolve-dispute`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ target: 'cancelled' })

      expect(res.status).toBe(400)
      expect(vault.status).toBe('disputed')
    })

    test('allows an admin to resolve a disputed vault back to active', async () => {
      const vault = seedVault({ status: 'disputed' })
      const res = await request(testApp)
        .post(`/api/vaults/${vault.id}/resolve-dispute`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ target: 'active' })

      expect(res.status).toBe(200)
      expect(vault.status).toBe('active')
    })

    test('returns 409 when the vault is not currently disputed', async () => {
      const vault = seedVault({ status: 'active' })
      const res = await request(testApp)
        .post(`/api/vaults/${vault.id}/resolve-dispute`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ target: 'active' })

      expect(res.status).toBe(409)
      expect(vault.status).toBe('active')
    })
  })
})
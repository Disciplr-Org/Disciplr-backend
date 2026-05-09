import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { app } from '../app.js'
import { vaultsRouter } from './vaults.js'
import { resetIdempotencyStore } from '../services/idempotency.js'
import { resetVaultStore, createVaultWithMilestones } from '../services/vaultStore.js'
import { runListContractTests } from '../tests/helpers/listContract.js'
import { generateAccessToken } from '../lib/auth-utils.js'
import { UserRole } from '../types/user.js'

let baseUrl = ''
let server: ReturnType<typeof testApp.listen> | null = null

// Test tokens for different users
const userToken = generateAccessToken({ userId: 'test-user', role: UserRole.USER })
const otherToken = generateAccessToken({ userId: 'other-user', role: UserRole.USER })

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
  assert.equal(response.status, 401)
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

  assert.equal(response.status, 400)
  const body = (await response.json()) as { error: { code: string; fields: { path: string; message: string }[] } }
  assert.equal(body.error.code, 'VALIDATION_ERROR')
  assert.equal(body.error.fields.some((f) => f.path === 'amount' && f.message.includes('positive')), true)
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
  const authHeader = `Bearer ${userToken}`

  const firstResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': authHeader, 'idempotency-key': idempotencyKey },
    body: JSON.stringify(validPayload()),
  })
  assert.equal(firstResponse.status, 201)

  const secondResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': authHeader, 'idempotency-key': idempotencyKey },
    body: JSON.stringify(validPayload()),
  })
  assert.equal(secondResponse.status, 200)
  const secondBody = (await secondResponse.json()) as { idempotency: { replayed: boolean } }
  assert.equal(secondBody.idempotency.replayed, true)

  const conflictResponse = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': authHeader, 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ ...validPayload(), amount: '999' }),
  })
  assert.equal(conflictResponse.status, 409)
  const conflictBody = (await conflictResponse.json()) as { error: { code: string } }
  assert.equal(conflictBody.error.code, 'IDEMPOTENCY_CONFLICT')
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
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'INVALID_IDEMPOTENCY_KEY')
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
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'INVALID_IDEMPOTENCY_KEY')
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
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'INVALID_IDEMPOTENCY_KEY')
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
  assert.equal(res1.status, 201)
  const body1 = (await res1.json()) as { vault: { id: string } }

  // User 2 uses the same key with a different payload – must NOT get 409
  const res2 = await fetch(`${baseUrl}/api/vaults`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${otherToken}`,
      'idempotency-key': key,
    },
    body: JSON.stringify({ ...validPayload(), amount: '500' }),
  })
  assert.equal(res2.status, 201)
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
      const res = await request(app)
        .get('/api/vaults')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      assert.ok(res.body.data)
      assert.ok(res.body.pagination)
      assert.equal(typeof res.body.pagination.page, 'number')
      assert.equal(typeof res.body.pagination.pageSize, 'number')
      assert.equal(typeof res.body.pagination.total, 'number')
      assert.equal(typeof res.body.pagination.totalPages, 'number')
      assert.equal(typeof res.body.pagination.hasNext, 'boolean')
      assert.equal(typeof res.body.pagination.hasPrev, 'boolean')
    })

    test('respects page and pageSize parameters', async () => {
      const res = await request(app)
        .get('/api/vaults?page=1&pageSize=2')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      assert.equal(res.body.pagination.page, 1)
      assert.equal(res.body.pagination.pageSize, 2)
      assert.equal(res.body.data.length, 2)
    })

    test('enforces maximum pageSize', async () => {
      const res = await request(app)
        .get('/api/vaults?pageSize=200')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      assert.ok(res.body.pagination.pageSize <= 100)
    })

    test('defaults to page 1 when page < 1', async () => {
      const res = await request(app)
        .get('/api/vaults?page=0')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      assert.equal(res.body.pagination.page, 1)
    })
  })

  // Sorting Contract
  describe('Sorting', () => {
    test('rejects invalid sort field with 400', async () => {
      const res = await request(app)
        .get('/api/vaults?sortBy=invalid_field')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 400)
      assert.ok(res.body.error)
    })

    test('accepts valid sort fields', async () => {
      const validFields = ['createdAt', 'amount', 'endTimestamp', 'status']
      for (const field of validFields) {
        const res = await request(app)
          .get(`/api/vaults?sortBy=${field}`)
          .set('Authorization', 'Bearer test-token')

        assert.equal(res.status, 200)
        assert.ok(res.body.data)
      }
    })

    test('supports ascending and descending order', async () => {
      const ascRes = await request(app)
        .get('/api/vaults?sortBy=amount&sortOrder=asc')
        .set('Authorization', 'Bearer test-token')

      const descRes = await request(app)
        .get('/api/vaults?sortBy=amount&sortOrder=desc')
        .set('Authorization', 'Bearer test-token')

      assert.equal(ascRes.status, 200)
      assert.equal(descRes.status, 200)
    })
  })

  // Filtering Contract
  describe('Filtering', () => {
    test('ignores non-allowed filter parameters', async () => {
      const res = await request(app)
        .get('/api/vaults?nonexistentFilter=value')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      assert.ok(res.body.data)
    })

    test('accepts valid filter fields', async () => {
      const res = await request(app)
        .get('/api/vaults?status=active')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      assert.ok(res.body.data)
    })

    test('filters by creator', async () => {
      const res = await request(app)
        .get('/api/vaults?creator=GTEST1234567890123456789012345678901234567890123456789012345678901')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      assert.ok(res.body.data)
    })
  })

  // Security Contract
  describe('Security', () => {
    test('requires authentication', async () => {
      const res = await request(app).get('/api/vaults')
      assert.equal(res.status, 401)
    })

    test('cannot sort by sensitive fields', async () => {
      const res = await request(app)
        .get('/api/vaults?sortBy=password')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 400)
    })
  })

  // Response Structure Contract
  describe('Response Structure', () => {
    test('returns array of items in data field', async () => {
      const res = await request(app)
        .get('/api/vaults')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      assert.equal(Array.isArray(res.body.data), true)
    })

    test('includes required fields in each item', async () => {
      const res = await request(app)
        .get('/api/vaults')
        .set('Authorization', 'Bearer test-token')

      assert.equal(res.status, 200)
      if (res.body.data.length > 0) {
        const item = res.body.data[0]
        assert.ok(item.id)
        assert.ok(item.creator)
        assert.ok(item.amount)
        assert.ok(item.status)
      }
    })
  })
})

// ─── Comprehensive Invalid Payload Tests ───────────────────────────────────

describe('POST /api/vaults - Invalid Payload Validation', () => {
  test('rejects payload with missing required fields', async () => {
    const invalidPayloads = [
      {},
      { amount: '1000' },
      { amount: '1000', startDate: '2030-01-01T00:00:00.000Z' },
      { amount: '1000', startDate: '2030-01-01T00:00:00.000Z', endDate: '2030-06-01T00:00:00.000Z' },
      { amount: '1000', startDate: '2030-01-01T00:00:00.000Z', endDate: '2030-06-01T00:00:00.000Z', verifier: stellar() },
      { amount: '1000', startDate: '2030-01-01T00:00:00.000Z', endDate: '2030-06-01T00:00:00.000Z', verifier: stellar(), destinations: { success: stellar() } },
    ]

    for (const payload of invalidPayloads) {
      const response = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify(payload),
      })

      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.error.code, 'VALIDATION_ERROR')
      assert.ok(Array.isArray(body.error.fields))
      assert.ok(body.error.fields.length > 0)
    }
  })

  test('rejects payload with invalid amount values', async () => {
    const invalidAmounts = [
      '0',
      '-1',
      '-1000',
      'abc',
      '1.5.5',
      'Infinity',
      '-Infinity',
      'NaN',
      '',
      '1000000001', // Above max
      '99999999999999999999999999999999999999999999999999', // Extremely large
    ]

    for (const amount of invalidAmounts) {
      const response = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ ...validPayload(), amount }),
      })

      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.error.code, 'VALIDATION_ERROR')
      assert.ok(body.error.fields.some((f: any) => f.path === 'amount'))
    }
  })

  test('accepts boundary amount values', async () => {
    const boundaryAmounts = [
      '1', // Minimum
      '1000000000', // Maximum
      '500',
      '999999999',
    ]

    for (const amount of boundaryAmounts) {
      const response = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ ...validPayload(), amount }),
      })

      // Should either succeed (201) or fail with non-validation error
      assert.ok([201, 400].includes(response.status))
      if (response.status === 400) {
        const body = await response.json()
        if (body.error.code === 'VALIDATION_ERROR') {
          assert.fail(`Boundary amount ${amount} should be valid`)
        }
      }
    }
  })

  test('rejects payload with invalid Stellar addresses', async () => {
    const invalidAddresses = [
      'A' + 'B'.repeat(55), // Wrong prefix
      'G' + 'A'.repeat(54), // Too short
      'G' + 'A'.repeat(56), // Too long
      'G' + 'a'.repeat(55), // Lowercase
      'G' + 'A'.repeat(50) + '12345', // Invalid characters
      'G' + 'A'.repeat(55) + 'X', // Too long
      '', // Empty
      'not-a-stellar-address',
      'GBAD5643Q3QDJPZYK5F5VVJFJQXH5FKQG5H2ZYZYJN5NQVA5Z3ZWJ2', // Real but wrong format
    ]

    for (const address of invalidAddresses) {
      const response = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ 
          ...validPayload(), 
          verifier: address,
          destinations: { success: address, failure: stellar() }
        }),
      })

      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.error.code, 'VALIDATION_ERROR')
      assert.ok(body.error.fields.some((f: any) => f.path === 'verifier'))
    }
  })

  test('rejects payload with invalid timestamps', async () => {
    const invalidTimestamps = [
      'invalid-date',
      '2023-13-01T00:00:00.000Z', // Invalid month
      '2023-02-30T00:00:00.000Z', // Invalid day
      '2023-01-01T24:00:00.000Z', // Invalid hour
      '2023-01-01T23:60:00.000Z', // Invalid minute
      '2023-01-01T23:59:60.000Z', // Invalid second
      '2023-01-01', // Missing time
      'January 1, 2023', // Wrong format
      '',
      1234567890, // Number instead of string
      null,
      undefined,
    ]

    for (const timestamp of invalidTimestamps) {
      const response = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ 
          ...validPayload(), 
          startDate: timestamp 
        }),
      })

      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.error.code, 'VALIDATION_ERROR')
      assert.ok(body.error.fields.some((f: any) => f.path === 'startDate'))
    }
  })

  test('rejects payload with invalid date relationships', async () => {
    const invalidDatePairs = [
      {
        startDate: '2030-06-01T00:00:00.000Z',
        endDate: '2030-01-01T00:00:00.000Z', // End before start
      },
      {
        startDate: '2030-06-01T00:00:00.000Z',
        endDate: '2030-06-01T00:00:00.000Z', // End equal to start
      },
    ]

    for (const dates of invalidDatePairs) {
      const response = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ 
          ...validPayload(), 
          ...dates 
        }),
      })

      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.error.code, 'VALIDATION_ERROR')
      assert.ok(body.error.fields.some((f: any) => f.path === 'endDate'))
    }
  })

  test('rejects payload with invalid milestones', async () => {
    const invalidMilestoneCases = [
      [], // Empty array
      [{ title: '', dueDate: '2030-02-01T00:00:00.000Z', amount: '100' }], // Empty title
      [{ title: '   ', dueDate: '2030-02-01T00:00:00.000Z', amount: '100' }], // Whitespace title
      [{ title: 'Test', dueDate: 'invalid-date', amount: '100' }], // Invalid date
      [{ title: 'Test', dueDate: '2030-02-01T00:00:00.000Z', amount: '-100' }], // Negative amount
      [{ title: 'Test', dueDate: '2030-02-01T00:00:00.000Z', amount: '0' }], // Zero amount
      [{ title: 'Test', dueDate: '2030-02-01T00:00:00.000Z', amount: 'abc' }], // Non-numeric amount
    ]

    for (const milestones of invalidMilestoneCases) {
      const response = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ 
          ...validPayload(), 
          milestones 
        }),
      })

      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.error.code, 'VALIDATION_ERROR')
      assert.ok(body.error.fields.length > 0)
    }
  })

  test('rejects payload with milestone dates before start date', async () => {
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
          {
            title: 'Test Milestone',
            dueDate: '2030-05-01T00:00:00.000Z', // Before start date
            amount: '100',
          },
        ],
      }),
    })

    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'VALIDATION_ERROR')
    assert.ok(body.error.fields.some((f: any) => f.path.startsWith('milestones.') && f.path.endsWith('.dueDate')))
  })

  test('rejects payload where milestone amounts exceed vault amount', async () => {
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
          { title: 'M2', dueDate: '2030-03-01T00:00:00.000Z', amount: '500' }, // Total exceeds vault
        ],
      }),
    })

    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'VALIDATION_ERROR')
    assert.ok(body.error.fields.some((f: any) => f.path === 'milestones'))
  })

  test('rejects payload with invalid types', async () => {
    const invalidTypeCases = [
      { amount: null },
      { amount: 123 }, // Should be string, but this is handled by preprocessing
      { startDate: true },
      { endDate: [] },
      { verifier: 123 },
      { destinations: 'not-an-object' },
      { destinations: { success: 123, failure: stellar() } },
      { milestones: 'not-an-array' },
      { milestones: [null] },
      { milestones: [{ title: 123, dueDate: '2030-02-01T00:00:00.000Z', amount: '100' }] },
    ]

    for (const invalidFields of invalidTypeCases) {
      const response = await fetch(`${baseUrl}/api/vaults`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ 
          ...validPayload(), 
          ...invalidFields 
        }),
      })

      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.error.code, 'VALIDATION_ERROR')
    }
  })

  test('handles maliciously large payloads safely', async () => {
    const largePayload = {
      ...validPayload(),
      milestones: Array.from({ length: 1000 }, (_, i) => ({
        title: 'A'.repeat(1000) + ` Milestone ${i}`,
        dueDate: `2030-${String(Math.floor(i / 31) + 1).padStart(2, '0')}-${String((i % 31) + 1).padStart(2, '0')}T00:00:00.000Z`,
        amount: '1',
        description: 'B'.repeat(5000), // Large description
      })),
    }

    const start = Date.now()
    const response = await fetch(`${baseUrl}/api/vaults`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${userToken}`,
      },
      body: JSON.stringify(largePayload),
    })
    const duration = Date.now() - start

    // Should respond quickly and reject the payload
    assert.ok(duration < 5000, 'Should handle large payloads quickly')
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'VALIDATION_ERROR')
  })

  test('provides consistent error format', async () => {
    const response = await fetch(`${baseUrl}/api/vaults`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        amount: '-100',
        verifier: 'invalid',
        startDate: 'invalid-date',
      }),
    })

    assert.equal(response.status, 400)
    const body = await response.json()
    
    // Check error envelope structure
    assert.equal(body.error.code, 'VALIDATION_ERROR')
    assert.ok(Array.isArray(body.error.fields))
    assert.ok(body.error.fields.length > 0)
    
    // Check field error structure
    body.error.fields.forEach((field: any) => {
      assert.ok(typeof field.path === 'string')
      assert.ok(typeof field.message === 'string')
      assert.ok(field.path.length > 0)
      assert.ok(field.message.length > 0)
    })
    
    // Should have errors for each invalid field
    const paths = body.error.fields.map((f: any) => f.path)
    assert.ok(paths.includes('amount'))
    assert.ok(paths.includes('verifier'))
    assert.ok(paths.includes('startDate'))
  })

  test('rejects malformed JSON', async () => {
    const response = await fetch(`${baseUrl}/api/vaults`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${userToken}`,
      },
      body: '{"invalid": json}', // Malformed JSON
    })

    assert.equal(response.status, 400)
  })

  test('rejects non-JSON content type', async () => {
    const response = await fetch(`${baseUrl}/api/vaults`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'authorization': `Bearer ${userToken}`,
      },
      body: 'not json',
    })

    assert.equal(response.status, 400)
  })
})

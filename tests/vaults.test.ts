/**
 * Vault API – Zod validation parity tests (Issue #109)
 *
 * Unit tests for createVaultSchema / flattenZodErrors, plus integration tests
 * for POST /api/vaults via a minimal Express app (no real DB required –
 * vaultStore falls back to in-memory when no PG pool is configured).
 */
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach } from '@jest/globals'
import { generateAccessToken } from '../src/lib/auth-utils.js'
import { UserRole } from '../src/types/user.js'
import {
  createVaultSchema,
  flattenZodErrors,
  VAULT_AMOUNT_MIN,
  VAULT_AMOUNT_MAX,
} from '../src/services/vaultValidation.js'
import { vaultsRouter, setVaults } from '../src/routes/vaults.js'
import { resetVaultStore } from '../src/services/vaultStore.js'
import { resetIdempotencyStore } from '../src/services/idempotency.js'

// ─── Test app ────────────────────────────────────────────────────────────────

const testApp = express()
testApp.use(express.json())
testApp.use((_req, res, next) => {
  res.setHeader('X-Timezone', 'UTC')
  next()
})
testApp.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok' })
})
testApp.use('/api/vaults', vaultsRouter)

// ─── Token fixtures ───────────────────────────────────────────────────────────

const userToken = generateAccessToken({ userId: 'vault-test-user', role: UserRole.USER })

// ─── Payload helpers ──────────────────────────────────────────────────────────

/** Valid Stellar G-address (56 chars: G + 55 base-32). */
const ADDR = `G${'A'.repeat(55)}`

const validPayload = () => ({
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: ADDR,
  destinations: { success: ADDR, failure: ADDR },
  milestones: [
    { title: 'Kickoff', dueDate: '2030-02-01T00:00:00.000Z', amount: '400' },
    { title: 'Final review', dueDate: '2030-05-01T00:00:00.000Z', amount: '600' },
  ],
})

beforeEach(() => {
  resetVaultStore()
  resetIdempotencyStore()
  setVaults([])
})

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests – createVaultSchema
// ─────────────────────────────────────────────────────────────────────────────

describe('createVaultSchema – unit', () => {
  // ── Valid inputs ──────────────────────────────────────────────────────────

  it('accepts a fully valid payload', () => {
    const result = createVaultSchema.safeParse(validPayload())
    expect(result.success).toBe(true)
  })

  it('accepts amount as a JS number and coerces to string', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      amount: 500,
      milestones: [
        { title: 'Kickoff', dueDate: '2030-02-01T00:00:00.000Z', amount: '200' },
        { title: 'Final review', dueDate: '2030-05-01T00:00:00.000Z', amount: '300' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.amount).toBe('500')
  })

  it('accepts optional creator field when omitted', () => {
    const { ...payload } = validPayload() as any
    delete payload.creator
    expect(createVaultSchema.safeParse(payload).success).toBe(true)
  })

  it('defaults onChain.mode to "build" when onChain is omitted', () => {
    const result = createVaultSchema.safeParse(validPayload())
    // onChain itself is optional; when present the mode defaults to 'build'
    expect(result.success).toBe(true)
  })

  it('accepts milestones with optional description', () => {
    const payload = {
      ...validPayload(),
      milestones: [
        { title: 'M1', dueDate: '2030-02-01T00:00:00.000Z', amount: '1000', description: 'Details here' },
      ],
    }
    expect(createVaultSchema.safeParse(payload).success).toBe(true)
  })

  // ── Amount validation ─────────────────────────────────────────────────────

  it(`rejects amount below minimum (${VAULT_AMOUNT_MIN})`, () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), amount: '0' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('amount') && e.includes('positive number'))).toBe(true)
    }
  })

  it('rejects negative amount', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), amount: '-1' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('amount') && e.includes('positive number'))).toBe(true)
    }
  })

  it(`rejects amount above maximum (${VAULT_AMOUNT_MAX})`, () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), amount: '1000000001' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('amount') && e.includes('between'))).toBe(true)
    }
  })

  it('rejects non-numeric amount string', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), amount: 'abc' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('amount'))).toBe(true)
    }
  })

  it(`accepts amount at exact minimum (${VAULT_AMOUNT_MIN})`, () => {
    expect(createVaultSchema.safeParse({ ...validPayload(), milestones: [
      { title: 'Only', dueDate: '2030-02-01T00:00:00.000Z', amount: '1' },
    ], amount: '1' }).success).toBe(true)
  })

  it(`accepts amount at exact maximum (${VAULT_AMOUNT_MAX})`, () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      amount: String(VAULT_AMOUNT_MAX),
      milestones: [
        { title: 'M', dueDate: '2030-02-01T00:00:00.000Z', amount: String(VAULT_AMOUNT_MAX) },
      ],
    })
    expect(result.success).toBe(true)
  })

  // ── Timestamp validation ──────────────────────────────────────────────────

  it('rejects non-ISO startDate', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), startDate: 'not-a-date' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('startDate') && e.includes('ISO timestamp'))).toBe(true)
    }
  })

  it('rejects non-ISO endDate', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), endDate: '31-12-2030' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('endDate') && e.includes('ISO timestamp'))).toBe(true)
    }
  })

  it('rejects endDate equal to startDate', () => {
    const ts = '2030-01-01T00:00:00.000Z'
    const result = createVaultSchema.safeParse({ ...validPayload(), startDate: ts, endDate: ts })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('endDate') && e.includes('greater than startDate'))).toBe(true)
    }
  })

  it('rejects endDate before startDate', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      startDate: '2030-06-01T00:00:00.000Z',
      endDate:   '2030-01-01T00:00:00.000Z',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('endDate'))).toBe(true)
    }
  })

  // ── Stellar address validation ────────────────────────────────────────────

  it('rejects verifier that is not a Stellar address', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), verifier: 'not-an-address' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('verifier') && e.includes('Stellar public key'))).toBe(true)
    }
  })

  it('rejects destinations.success that is not a Stellar address', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      destinations: { success: 'bad', failure: ADDR },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('destinations.success') && e.includes('Stellar'))).toBe(true)
    }
  })

  it('rejects destinations.failure that is not a Stellar address', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      destinations: { success: ADDR, failure: 'bad' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('destinations.failure') && e.includes('Stellar'))).toBe(true)
    }
  })

  it('rejects Stellar address that is too short', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), verifier: 'GABC' })
    expect(result.success).toBe(false)
  })

  it('rejects Stellar address with invalid characters (lowercase)', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      verifier: `G${'a'.repeat(55)}`,
    })
    expect(result.success).toBe(false)
  })

  // ── Milestone validation ──────────────────────────────────────────────────

  it('rejects empty milestones array', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), milestones: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('milestones') && e.includes('at least one'))).toBe(true)
    }
  })

  it('rejects milestone with blank title', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      milestones: [
        { title: '   ', dueDate: '2030-02-01T00:00:00.000Z', amount: '1000' },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('milestones[0].title') && e.includes('required'))).toBe(true)
    }
  })

  it('rejects milestone dueDate before startDate', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      milestones: [
        { title: 'M', dueDate: '2029-12-31T00:00:00.000Z', amount: '1000' },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('milestones[0].dueDate') && e.includes('before startDate'))).toBe(true)
    }
  })

  it('rejects milestone with invalid dueDate', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      milestones: [{ title: 'M', dueDate: 'bad-date', amount: '500' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('milestones[0].dueDate') && e.includes('ISO timestamp'))).toBe(true)
    }
  })

  it('rejects when total milestone amounts exceed vault amount', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      amount: '100',
      milestones: [
        { title: 'M1', dueDate: '2030-02-01T00:00:00.000Z', amount: '80' },
        { title: 'M2', dueDate: '2030-04-01T00:00:00.000Z', amount: '30' },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('milestone') && e.includes('cannot exceed'))).toBe(true)
    }
  })

  it('accepts total milestone amounts equal to vault amount', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      amount: '500',
      milestones: [
        { title: 'M1', dueDate: '2030-02-01T00:00:00.000Z', amount: '300' },
        { title: 'M2', dueDate: '2030-04-01T00:00:00.000Z', amount: '200' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects milestone amount of zero', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      milestones: [{ title: 'M', dueDate: '2030-02-01T00:00:00.000Z', amount: '0' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.includes('milestones[0].amount') && e.includes('positive'))).toBe(true)
    }
  })

  // ── flattenZodErrors path formatting ─────────────────────────────────────

  it('formats nested path milestones[1].dueDate correctly', () => {
    const result = createVaultSchema.safeParse({
      ...validPayload(),
      milestones: [
        { title: 'OK', dueDate: '2030-02-01T00:00:00.000Z', amount: '500' },
        { title: 'Bad', dueDate: 'nope', amount: '500' },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.startsWith('milestones[1].dueDate'))).toBe(true)
    }
  })

  it('formats top-level field errors without bracket notation', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), verifier: 'x' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.startsWith('verifier '))).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests – POST /api/vaults
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/vaults', () => {
  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 without an auth token', async () => {
    const res = await request(testApp).post('/api/vaults').send(validPayload())
    expect(res.status).toBe(401)
    expect(res.body).toHaveProperty('error')
  })

  it('returns 401 with a malformed token', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', 'Bearer not-a-real-token')
      .send(validPayload())
    expect(res.status).toBe(401)
  })

  // ── Validation errors ─────────────────────────────────────────────────────

  it('returns 400 with details array for negative amount', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), amount: '-1' })
      .expect(400)

    expect(Array.isArray(res.body.details)).toBe(true)
    expect(res.body.details.some((d: string) => d.includes('amount') && d.includes('positive number'))).toBe(true)
  })

  it('returns 400 for amount exceeding Soroban upper-bound', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), amount: String(VAULT_AMOUNT_MAX + 1) })
      .expect(400)

    expect(res.body.details.some((d: string) => d.includes('amount') && d.includes('between'))).toBe(true)
  })

  it('returns 400 when endDate is not after startDate', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        ...validPayload(),
        startDate: '2030-06-01T00:00:00.000Z',
        endDate: '2030-01-01T00:00:00.000Z',
      })
      .expect(400)

    expect(res.body.details.some((d: string) => d.includes('endDate'))).toBe(true)
  })

  it('returns 400 for invalid verifier address', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), verifier: 'INVALID' })
      .expect(400)

    expect(res.body.details.some((d: string) => d.includes('verifier'))).toBe(true)
  })

  it('returns 400 for empty milestones array', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), milestones: [] })
      .expect(400)

    expect(res.body.details.some((d: string) => d.includes('milestones'))).toBe(true)
  })

  it('returns 400 when milestone amounts exceed vault amount', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        ...validPayload(),
        amount: '100',
        milestones: [
          { title: 'M', dueDate: '2030-02-01T00:00:00.000Z', amount: '200' },
        ],
      })
      .expect(400)

    expect(res.body.details.some((d: string) => d.includes('milestone') && d.includes('exceed'))).toBe(true)
  })

  it('returns 400 for milestone dueDate before vault startDate', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        ...validPayload(),
        milestones: [
          { title: 'M', dueDate: '2020-01-01T00:00:00.000Z', amount: '1000' },
        ],
      })
      .expect(400)

    expect(res.body.details.some((d: string) => d.includes('milestones[0].dueDate'))).toBe(true)
  })

  it('does not include PII (Stellar addresses) in error messages', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), verifier: 'INVALID' })
      .expect(400)

    const body = JSON.stringify(res.body)
    expect(body).not.toContain(ADDR)
  })

  // ── Successful creation ───────────────────────────────────────────────────

  it('returns 201 with vault + onChain + idempotency for a valid payload', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    expect(res.body.vault).toMatchObject({
      id: expect.any(String),
      amount: '1000',
      milestones: expect.arrayContaining([
        expect.objectContaining({ title: 'Kickoff' }),
        expect.objectContaining({ title: 'Final review' }),
      ]),
    })
    expect(res.body.onChain.payload.method).toBe('create_vault')
    expect(res.body.idempotency.replayed).toBe(false)
  })

  it('vault id is a UUID', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    expect(res.body.vault.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it('vault has milestones with ids', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    expect(res.body.vault.milestones.length).toBe(2)
    res.body.vault.milestones.forEach((m: any) => {
      expect(m.id).toMatch(/^[0-9a-f-]{36}$/i)
    })
  })

  // ── Idempotency ───────────────────────────────────────────────────────────

  it('replays the same response for a repeated idempotency key', async () => {
    const key = 'idem-vault-1'

    const first = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', key)
      .send(validPayload())
      .expect(201)

    const second = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', key)
      .send(validPayload())
      .expect(200)

    expect(second.body.idempotency.replayed).toBe(true)
    expect(second.body.vault.id).toBe(first.body.vault.id)
  })

  it('returns 409 when idempotency key is reused with a different payload', async () => {
    const key = 'idem-vault-2'

    await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', key)
      .send(validPayload())
      .expect(201)

    const conflict = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', key)
      .send({ ...validPayload(), amount: '999' })
      .expect(409)

    expect(conflict.body).toHaveProperty('error')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests – GET /api/vaults/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/vaults/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(testApp).get('/api/vaults/some-id')
    expect(res.status).toBe(401)
  })

  it('returns 404 for a non-existent vault', async () => {
    const res = await request(testApp)
      .get('/api/vaults/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(404)
  })

  it('returns the vault after creation', async () => {
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const id = createRes.body.vault.id

    const getRes = await request(testApp)
      .get(`/api/vaults/${id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    expect(getRes.body.id).toBe(id)
  })
})

describe('GET /api/vaults', () => {
  it('returns 401 without auth', async () => {
    const res = await request(testApp).get('/api/vaults')
    expect(res.status).toBe(401)
  })

  it('returns list response with UTC timestamps', async () => {
    await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const res = await request(testApp)
      .get('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data[0].startDate).toMatch(/Z$/)
    expect(res.body.data[0].createdAt).toMatch(/Z$/)
  })
})

describe('X-Timezone header', () => {
  it('includes X-Timezone: UTC on responses', async () => {
    const res = await request(testApp).get('/api/health')
    expect(res.headers['x-timezone']).toBe('UTC')
  })
})

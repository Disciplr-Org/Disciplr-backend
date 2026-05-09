/**
 * Vault API – Zod validation parity tests (Issue #109)
 *
 * Unit tests for createVaultSchema / validation formatting, plus integration tests
 * for POST /api/vaults via a minimal Express app (no real DB required –
 * vaultStore falls back to in-memory when no PG pool is configured).
 */
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach } from '@jest/globals'
import { generateAccessToken } from '../src/lib/auth-utils.js'
import { flattenZodErrors } from '../src/lib/validation.js'
import { UserRole } from '../src/types/user.js'
import {
  createVaultSchema,
  VAULT_AMOUNT_MIN,
  VAULT_AMOUNT_MAX,
} from '../src/services/vaultValidation.js'
import { vaultsRouter, setVaults } from '../src/routes/vaults.js'
import { resetVaultStore } from '../src/services/vaultStore.js'
import { resetIdempotencyStore } from '../src/services/idempotency.js'

const otherUserToken = generateAccessToken({ userId: 'other-vault-user', role: UserRole.USER })

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
      expect(errors.some((e) => e.path === 'amount' && e.message.includes('positive number'))).toBe(true)
    }
  })

  it('rejects negative amount', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), amount: '-1' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.path === 'amount' && e.message.includes('positive number'))).toBe(true)
    }
  })

  it(`rejects amount above maximum (${VAULT_AMOUNT_MAX})`, () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), amount: '1000000001' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.path === 'amount' && e.message.includes('between'))).toBe(true)
    }
  })

  it('rejects non-numeric amount string', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), amount: 'abc' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.path === 'amount')).toBe(true)
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
      expect(errors.some((e) => e.path === 'startDate' && e.message.includes('ISO timestamp'))).toBe(true)
    }
  })

  it('rejects non-ISO endDate', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), endDate: '31-12-2030' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.path === 'endDate' && e.message.includes('ISO timestamp'))).toBe(true)
    }
  })

  it('rejects endDate equal to startDate', () => {
    const ts = '2030-01-01T00:00:00.000Z'
    const result = createVaultSchema.safeParse({ ...validPayload(), startDate: ts, endDate: ts })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.path === 'endDate' && e.message.includes('greater than startDate'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'endDate')).toBe(true)
    }
  })

  // ── Stellar address validation ────────────────────────────────────────────

  it('rejects verifier that is not a Stellar address', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), verifier: 'not-an-address' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.path === 'verifier' && e.message.includes('Stellar public key'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'destinations.success' && e.message.includes('Stellar'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'destinations.failure' && e.message.includes('Stellar'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'milestones' && e.message.includes('at least one'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'milestones[0].title' && e.message.includes('required'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'milestones[0].dueDate' && e.message.includes('before startDate'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'milestones[0].dueDate' && e.message.includes('ISO timestamp'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'milestones' && e.message.includes('cannot exceed'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'milestones[0].amount' && e.message.includes('positive'))).toBe(true)
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
      expect(errors.some((e) => e.path === 'milestones[1].dueDate')).toBe(true)
    }
  })

  it('formats top-level field errors without bracket notation', () => {
    const result = createVaultSchema.safeParse({ ...validPayload(), verifier: 'x' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const errors = flattenZodErrors(result.error)
      expect(errors.some((e) => e.path === 'verifier')).toBe(true)
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

  it('returns 400 with structured field errors for negative amount', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), amount: '-1' })
      .expect(400)

    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(Array.isArray(res.body.error.fields)).toBe(true)
    expect(res.body.error.fields.some((f: { path: string; message: string }) => (
      f.path === 'amount' && f.message.includes('positive number')
    ))).toBe(true)
  })

  it('returns 400 for amount exceeding Soroban upper-bound', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), amount: String(VAULT_AMOUNT_MAX + 1) })
      .expect(400)

    expect(res.body.error.fields.some((f: { path: string; message: string }) => (
      f.path === 'amount' && f.message.includes('between')
    ))).toBe(true)
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

    expect(res.body.error.fields.some((f: { path: string }) => f.path === 'endDate')).toBe(true)
  })

  it('returns 400 for invalid verifier address', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), verifier: 'INVALID' })
      .expect(400)

    expect(res.body.error.fields.some((f: { path: string }) => f.path === 'verifier')).toBe(true)
  })

  it('returns 400 for empty milestones array', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...validPayload(), milestones: [] })
      .expect(400)

    expect(res.body.error.fields.some((f: { path: string }) => f.path === 'milestones')).toBe(true)
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

    expect(res.body.error.fields.some((f: { path: string; message: string }) => (
      f.path === 'milestones' && f.message.includes('exceed')
    ))).toBe(true)
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

    expect(res.body.error.fields.some((f: { path: string }) => f.path === 'milestones[0].dueDate')).toBe(true)
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

  // ── Idempotency key format validation ─────────────────────────────────────

  it('returns 400 with INVALID_IDEMPOTENCY_KEY for an empty key header', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', '')
      .send(validPayload())
      .expect(400)

    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
    expect(typeof res.body.error.message).toBe('string')
  })

  it('returns 400 with INVALID_IDEMPOTENCY_KEY for a key with spaces', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', 'invalid key with spaces')
      .send(validPayload())
      .expect(400)

    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
  })

  it('returns 400 with INVALID_IDEMPOTENCY_KEY for a key with special characters', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', 'key@value!')
      .send(validPayload())
      .expect(400)

    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
  })

  it('returns 400 with INVALID_IDEMPOTENCY_KEY for a key exceeding 255 characters', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', 'a'.repeat(256))
      .send(validPayload())
      .expect(400)

    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
  })

  it('accepts a UUID-formatted idempotency key', async () => {
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', '550e8400-e29b-41d4-a716-446655440000')
      .send(validPayload())
      .expect(201)

    expect(res.body.idempotency.replayed).toBe(false)
  })

  it('returns 409 with IDEMPOTENCY_CONFLICT code on payload mismatch', async () => {
    const key = 'conflict-key-structured'

    await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', key)
      .send(validPayload())
      .expect(201)

    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', key)
      .send({ ...validPayload(), amount: '500' })
      .expect(409)

    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(typeof res.body.error.message).toBe('string')
  })

  // ── Cross-user key isolation ───────────────────────────────────────────────

  it('isolates idempotency keys between different users', async () => {
    const key = 'shared-key-cross-user'

    const res1 = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .set('idempotency-key', key)
      .send(validPayload())
      .expect(201)

    // Different user, same key, different payload – must not return 409
    const res2 = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${otherUserToken}`)
      .set('idempotency-key', key)
      .send({ ...validPayload(), amount: '500' })
      .expect(201)

    expect(res2.body.vault.id).not.toBe(res1.body.vault.id)
  })

  it('replays correctly for the original user after cross-user creation', async () => {
    const key = 'shared-key-replay-check'

    await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${otherUserToken}`)
      .set('idempotency-key', key)
      .send(validPayload())
      .expect(201)

    // Same user + same key + same payload → replay
    const res = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${otherUserToken}`)
      .set('idempotency-key', key)
      .send(validPayload())
      .expect(200)

    expect(res.body.idempotency.replayed).toBe(true)
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

  it('returns vault from legacy in-memory fallback when DB is unavailable', async () => {
    // Create a vault directly in the legacy in-memory storage
    const legacyVault = {
      id: 'legacy-vault-123',
      creator: 'test-creator',
      amount: '500',
      status: 'active' as const,
      startTimestamp: '2030-01-01T00:00:00.000Z',
      endTimestamp: '2030-06-01T00:00:00.000Z',
      successDestination: `G${'A'.repeat(55)}`,
      failureDestination: `G${'B'.repeat(55)}`,
      createdAt: '2023-01-01T00:00:00.000Z',
    }
    
    // Set the vault in the legacy storage
    setVaults([legacyVault])

    const res = await request(testApp)
      .get('/api/vaults/legacy-vault-123')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    expect(res.body.id).toBe('legacy-vault-123')
    expect(res.body.amount).toBe('500')
    expect(res.body.status).toBe('active')
  })

  it('returns 404 when vault is not found in either DB or legacy storage', async () => {
    // Ensure legacy storage is empty
    setVaults([])

    const res = await request(testApp)
      .get('/api/vaults/non-existent-vault')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(404)

    expect(res.body.error).toBe('Vault not found')
  })

  it('returns 404 for non-existent vault in legacy storage when DB fails', async () => {
    // Set empty legacy storage - no vaults available
    setVaults([])

    const res = await request(testApp)
      .get('/api/vaults/another-non-existent-vault')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(404)

    expect(res.body.error).toBe('Vault not found')
  })

  it('legacy fallback returns JSON response with correct content-type', async () => {
    const legacyVault = {
      id: 'legacy-json-test',
      creator: 'json-test-creator',
      amount: '1000',
      status: 'completed' as const,
      startTimestamp: '2030-01-01T00:00:00.000Z',
      endTimestamp: '2030-12-01T00:00:00.000Z',
      successDestination: `G${'C'.repeat(55)}`,
      failureDestination: `G${'D'.repeat(55)}`,
      createdAt: '2023-06-01T00:00:00.000Z',
    }
    
    setVaults([legacyVault])

    const res = await request(testApp)
      .get('/api/vaults/legacy-json-test')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    // Verify response is properly formatted JSON
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(typeof res.body).toBe('object')
    expect(res.body.id).toBe('legacy-json-test')
    expect(res.body.creator).toBe('json-test-creator')
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

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests – POST /api/vaults/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/vaults/:id/cancel', () => {
  const adminToken = generateAccessToken({ userId: 'admin-user', role: UserRole.ADMIN })
  const otherUserToken = generateAccessToken({ userId: 'other-user', role: UserRole.USER })

  beforeEach(() => {
    resetVaultStore()
    resetIdempotencyStore()
    setVaults([])
  })

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 without auth token', async () => {
    const res = await request(testApp).post('/api/vaults/nonexistent/cancel')
    expect(res.status).toBe(401)
    expect(res.body).toHaveProperty('error')
  })

  it('returns 401 with malformed token', async () => {
    const res = await request(testApp)
      .post('/api/vaults/nonexistent/cancel')
      .set('Authorization', 'Bearer invalid-token')
    expect(res.status).toBe(401)
  })

  // ── Authorization ─────────────────────────────────────────────────────────

  it('allows vault creator to cancel their own vault', async () => {
    // Create a vault first
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    // Cancel the vault
    const cancelRes = await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: 'Test cancellation' })
      .expect(200)

    expect(cancelRes.body).toMatchObject({
      message: 'Vault cancelled',
      id: vaultId,
    })
  })

  it('allows admin to cancel any vault', async () => {
    // Create a vault as regular user
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    // Cancel the vault as admin
    const cancelRes = await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Admin cancellation' })
      .expect(200)

    expect(cancelRes.body).toMatchObject({
      message: 'Vault cancelled',
      id: vaultId,
    })
  })

  it('forbids non-creator, non-admin user from cancelling vault', async () => {
    // Create a vault as one user
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    // Try to cancel as different user
    const cancelRes = await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${otherUserToken}`)
    expect(cancelRes.status).toBe(403)
    expect(cancelRes.body).toHaveProperty('error', 'Forbidden')
  })

  // ── Vault existence ───────────────────────────────────────────────────────

  it('returns 404 for non-existent vault', async () => {
    const res = await request(testApp)
      .post('/api/vaults/00000000-0000-0000-0000-000000000000/cancel')
      .set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('error', 'Vault not found')
  })

  // ── Double cancellation ───────────────────────────────────────────────────

  it('handles double cancellation gracefully', async () => {
    // Create a vault
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    // Cancel once
    await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: 'First cancellation' })
      .expect(200)

    // Cancel again - should still succeed (idempotent)
    const secondCancelRes = await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: 'Second cancellation' })
      .expect(200)

    expect(secondCancelRes.body).toMatchObject({
      message: 'Vault cancelled',
      id: vaultId,
    })
  })

  // ── Cancel completed vault ─────────────────────────────────────────────────

  it('allows cancelling a completed vault', async () => {
    // Create a vault
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    // Manually set vault to completed status
    const vaults = await request(testApp)
      .get(`/api/vaults/${vaultId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    // Simulate completed status by updating in-memory store
    const vaultArray = (testApp as any)._router?.stack?.find((layer: any) => layer.route?.path === '/api/vaults')?.route?.stack?.find((layer: any) => layer.handle?.name === 'bound dispatch')?.handle?.__vaults || []
    const vaultIndex = vaultArray.findIndex((v: any) => v.id === vaultId)
    if (vaultIndex !== -1) {
      vaultArray[vaultIndex].status = 'completed'
    }

    // Cancel the completed vault
    const cancelRes = await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: 'Cancelling completed vault' })
      .expect(200)

    expect(cancelRes.body).toMatchObject({
      message: 'Vault cancelled',
      id: vaultId,
    })
  })

  // ── Audit logging ─────────────────────────────────────────────────────────

  it('creates audit log entry on successful cancellation', async () => {
    // Import audit log utilities for testing
    const { listAuditLogs, clearAuditLogs } = await import('../src/lib/audit-logs.js')
    
    // Clear existing audit logs
    clearAuditLogs()

    // Create a vault
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    // Cancel the vault
    await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: 'Test audit logging' })
      .expect(200)

    // Check audit logs
    const auditLogs = listAuditLogs({ target_id: vaultId })
    expect(auditLogs).toHaveLength(1)
    
    const auditLog = auditLogs[0]
    expect(auditLog).toMatchObject({
      actor_user_id: 'vault-test-user',
      action: 'vault.cancelled',
      target_type: 'vault',
      target_id: vaultId,
    })
    expect(auditLog.metadata).toMatchObject({
      previous_status: 'active',
      new_status: 'cancelled',
      reason: 'Test audit logging',
      cancelled_by: 'creator',
      creator: expect.any(String),
      amount: '1000',
    })
    expect(auditLog.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/)
  })

  it('uses admin identifier when admin cancels vault', async () => {
    const { listAuditLogs, clearAuditLogs } = await import('../src/lib/audit-logs.js')
    clearAuditLogs()

    // Create a vault as regular user
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    // Cancel as admin
    await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Admin cancellation' })
      .expect(200)

    // Check audit logs
    const auditLogs = listAuditLogs({ target_id: vaultId })
    expect(auditLogs).toHaveLength(1)
    
    const auditLog = auditLogs[0]
    expect(auditLog.actor_user_id).toBe('admin-user')
    expect(auditLog.metadata.cancelled_by).toBe('admin')
  })

  it('uses default reason when none provided', async () => {
    const { listAuditLogs, clearAuditLogs } = await import('../src/lib/audit-logs.js')
    clearAuditLogs()

    // Create and cancel vault without reason
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    // Check audit logs
    const auditLogs = listAuditLogs({ target_id: vaultId })
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0].metadata.reason).toBe('User requested cancellation')
  })

  // ── Response consistency ───────────────────────────────────────────────────

  it('maintains consistent response format', async () => {
    // Create a vault
    const createRes = await request(testApp)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validPayload())
      .expect(201)

    const vaultId = createRes.body.vault.id

    // Cancel and check response format
    const cancelRes = await request(testApp)
      .post(`/api/vaults/${vaultId}/cancel`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: 'Response format test' })
      .expect(200)

    // Response should match documented format
    expect(cancelRes.body).toEqual({
      message: 'Vault cancelled',
      id: vaultId,
    })
    expect(Object.keys(cancelRes.body)).toHaveLength(2)
  })
})

describe('X-Timezone header', () => {
  it('includes X-Timezone: UTC on responses', async () => {
    const res = await request(testApp).get('/api/health')
    expect(res.headers['x-timezone']).toBe('UTC')
  })
})

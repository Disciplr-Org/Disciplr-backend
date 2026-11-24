import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import request from 'supertest'
import { Keypair } from '@stellar/stellar-sdk'
import { createApp } from '../index.mjs'
import { MemoryStore, PgStore } from '../../apilib/store.mjs'
import { resetMemoryBuckets } from '../../apilib/rateLimit.mjs'
import { canonicalJson, requestHash, IDEMPOTENCY_KEY_PATTERN } from '../../apilib/idempotency.mjs'
import { testDatabase } from '../../db/__tests__/database.mjs'

// One suite bursts far more writes than the default per-IP budget allows.
const originalWriteIpMax = process.env.RATE_LIMIT_WRITE_IP_MAX
const originalWriteAddrMax = process.env.RATE_LIMIT_WRITE_ADDR_MAX
const originalCronSecret = process.env.CRON_SECRET
process.env.RATE_LIMIT_WRITE_IP_MAX = '1000'
process.env.RATE_LIMIT_WRITE_ADDR_MAX = '1000'

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterAll(() => {
  restoreEnv('RATE_LIMIT_WRITE_IP_MAX', originalWriteIpMax)
  restoreEnv('RATE_LIMIT_WRITE_ADDR_MAX', originalWriteAddrMax)
  restoreEnv('CRON_SECRET', originalCronSecret)
})

const address = () => Keypair.random().publicKey()

function vaultPayload(overrides = {}) {
  const creator = overrides.creator || address()
  const verifier = overrides.verifier || address()
  const now = Date.now()
  return {
    name: 'Idempotency Vault',
    creator,
    verifier,
    amount: 1000,
    startDate: new Date(now + 60000).toISOString(),
    endDate: new Date(now + 30 * 86400000).toISOString(),
    successDestination: creator,
    failureDestination: address(),
    milestones: [
      { title: 'Milestone 1', amount: 500, dueDate: new Date(now + 10 * 86400000).toISOString() },
      { title: 'Milestone 2', amount: 500, dueDate: new Date(now + 20 * 86400000).toISOString() },
    ],
    ...overrides,
  }
}

describe('Idempotency-Key request fingerprinting', () => {
  it('canonicalises JSON so key order never changes the hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ m: { z: 1, y: [3, { q: 1, p: 2 }] } }))
      .toBe(canonicalJson({ m: { y: [3, { p: 2, q: 1 }], z: 1 } }))
    expect(requestHash('POST', '/vaults', { b: 1, a: 2 }))
      .toBe(requestHash('POST', '/vaults', { a: 2, b: 1 }))
  })

  it('changes when method, path or body change', () => {
    expect(requestHash('POST', '/vaults', {})).not.toBe(requestHash('PUT', '/vaults', {}))
    expect(requestHash('POST', '/vaults', {})).not.toBe(requestHash('POST', '/vaults/v1/fail', {}))
    expect(requestHash('POST', '/vaults', { a: 1 })).not.toBe(requestHash('POST', '/vaults', { a: 2 }))
  })

  it('matches the documented key pattern', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('abc-123_XYZ')).toBe(true)
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(255))).toBe(true)
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(7))).toBe(false)
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(256))).toBe(false)
    expect(IDEMPOTENCY_KEY_PATTERN.test('has space')).toBe(false)
    expect(IDEMPOTENCY_KEY_PATTERN.test('colon:key')).toBe(false)
  })
})

function defineIdempotencySuite(label, createContext) {
  describe(`Idempotency-Key behaviour (${label} store)`, () => {
    let ctx

    beforeAll(async () => {
      ctx = await createContext()
    }, 120000)

    afterAll(async () => {
      await ctx?.teardown?.()
    })

    beforeEach(() => {
      resetMemoryBuckets()
    })

    const postVault = (app, key, payload) => {
      const req = request(app).post('/api/vaults').send(payload)
      return key === undefined ? req : req.set('Idempotency-Key', key)
    }

    it('replays the original response for a sequential retry and creates one vault', async () => {
      const { app, store } = ctx
      const payload = vaultPayload()
      const key = 'seq-replay-key-0001'

      const first = await postVault(app, key, payload)
      expect(first.status).toBe(201)
      expect(first.headers['idempotent-replayed']).toBeUndefined()

      const second = await postVault(app, key, payload)
      expect(second.status).toBe(201)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.headers['content-type']).toContain('application/json')
      expect(second.text).toBe(first.text)

      const { items } = await store.listVaults({ creator: payload.creator })
      expect(items).toHaveLength(1)
    })

    it('rejects the same key with a different body with 422', async () => {
      const { app, store } = ctx
      const payload = vaultPayload()
      const key = 'body-mismatch-key-1'

      const first = await postVault(app, key, payload)
      expect(first.status).toBe(201)

      const second = await postVault(app, key, { ...payload, name: 'A different name' })
      expect(second.status).toBe(422)
      expect(second.body).toEqual({ error: 'Idempotency-Key was used with a different request' })
      expect(second.headers['idempotent-replayed']).toBeUndefined()

      const { items } = await store.listVaults({ creator: payload.creator })
      expect(items).toHaveLength(1)
    })

    it('never creates two vaults for concurrent duplicates', async () => {
      const { app, store } = ctx
      const payload = vaultPayload()
      const key = 'concurrent-key-0001'

      const [a, b] = await Promise.all([
        postVault(app, key, payload),
        postVault(app, key, payload),
      ])

      const originals = [a, b].filter(
        (r) => r.status === 201 && r.headers['idempotent-replayed'] !== 'true',
      )
      expect(originals).toHaveLength(1)

      const other = a === originals[0] ? b : a
      const replayed = other.status === 201 && other.headers['idempotent-replayed'] === 'true'
      const inProgress = other.status === 409 && other.body.error === 'Request in progress'
      expect(replayed || inProgress).toBe(true)
      if (replayed) expect(other.text).toBe(originals[0].text)

      const { items } = await store.listVaults({ creator: payload.creator })
      expect(items).toHaveLength(1)
    })

    it('replays a retried milestone validation instead of returning 409', async () => {
      const { app } = ctx
      const payload = vaultPayload()
      const created = await postVault(app, undefined, payload)
      expect(created.status).toBe(201)
      const vault = created.body.data
      const url = `/api/vaults/${vault.id}/milestones/${vault.milestones[0].id}/validate`
      const key = 'validate-retry-key-01'

      const first = await request(app).post(url).set('Idempotency-Key', key).send({ verifier: payload.verifier })
      expect(first.status).toBe(200)

      const second = await request(app).post(url).set('Idempotency-Key', key).send({ verifier: payload.verifier })
      expect(second.status).toBe(200)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.text).toBe(first.text)

      // The same retry without a key really is a conflict — proving the
      // first attempt completed and only the replay masks the 409.
      const third = await request(app).post(url).send({ verifier: payload.verifier })
      expect(third.status).toBe(409)
      expect(third.body.error).toBe('Milestone already validated')
    })

    it('releases the reservation when the handler throws so the key is retryable', async () => {
      const { app, store } = ctx
      const base = store
      let shouldThrow = true
      const guarded = Object.create(base)
      guarded.createVault = async (...args) => {
        if (shouldThrow) {
          shouldThrow = false
          throw new Error('simulated store failure')
        }
        return base.createVault(...args)
      }
      const failingApp = createApp(async () => guarded)

      const payload = vaultPayload()
      const key = 'throwing-key-00001'

      const first = await postVault(failingApp, key, payload)
      expect(first.status).toBe(500)

      const second = await postVault(failingApp, key, payload)
      expect(second.status).toBe(201)
      expect(second.headers['idempotent-replayed']).toBeUndefined()

      const { items } = await store.listVaults({ creator: payload.creator })
      expect(items).toHaveLength(1)
    })

    it('rejects invalid Idempotency-Key values with 400 before any work runs', async () => {
      const { app, store } = ctx
      const payload = vaultPayload()
      const invalid = [
        'short1', // shorter than 8 characters
        'a'.repeat(256), // longer than 255 characters
        'with space',
        'colon:key',
        'plus+key',
        'slash/key',
        'dot.key!',
      ]

      for (const key of invalid) {
        const res = await postVault(app, key, payload)
        expect(res.status).toBe(400)
        expect(res.body.error).toContain('Invalid Idempotency-Key')
      }

      const { items } = await store.listVaults({ creator: payload.creator })
      expect(items).toHaveLength(0)
    })

    it('stores and replays a 4xx validation failure', async () => {
      const { app, store } = ctx
      const payload = vaultPayload()
      payload.admin = true // unknown field: rejected by strict validation
      const key = 'validation-key-001'

      const first = await postVault(app, key, payload)
      expect(first.status).toBe(400)

      const second = await postVault(app, key, payload)
      expect(second.status).toBe(400)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.text).toBe(first.text)

      const { items } = await store.listVaults({ creator: payload.creator })
      expect(items).toHaveLength(0)
    })

    it('hashes the body canonically so re-ordered keys still replay', async () => {
      const { app } = ctx
      const payload = vaultPayload()
      const key = 'canonical-key-0001'

      const first = await postVault(app, key, payload)
      expect(first.status).toBe(201)

      const reordered = {}
      for (const k of Object.keys(payload).reverse()) reordered[k] = payload[k]
      const second = await postVault(app, key, reordered)
      expect(second.status).toBe(201)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.text).toBe(first.text)
    })

    it('scopes reservations so one key works independently on another route', async () => {
      const { app } = ctx
      const payload = vaultPayload()
      const key = 'shared-key-across-routes'

      const created = await postVault(app, key, payload)
      expect(created.status).toBe(201)
      const vault = created.body.data
      const url = `/api/vaults/${vault.id}/fail`

      // Different scope: the same key must claim a fresh reservation, not 422.
      const firstFail = await request(app).post(url).set('Idempotency-Key', key).send({ verifier: payload.verifier })
      expect(firstFail.status).toBe(200)

      const secondFail = await request(app).post(url).set('Idempotency-Key', key).send({ verifier: payload.verifier })
      expect(secondFail.status).toBe(200)
      expect(secondFail.headers['idempotent-replayed']).toBe('true')
      expect(secondFail.text).toBe(firstFail.text)
    })

    it('creates separate vaults when no Idempotency-Key is sent', async () => {
      const { app, store } = ctx
      const payload = vaultPayload()

      const a = await postVault(app, undefined, payload)
      const b = await postVault(app, undefined, payload)
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      expect(b.body.data.id).not.toBe(a.body.data.id)

      const { items } = await store.listVaults({ creator: payload.creator })
      expect(items).toHaveLength(2)
    })

    it('ignores expired reservations and cleans them up', async () => {
      const { store } = ctx
      const scope = 'vault.create'
      const key = 'expiry-key-000001'
      const t0 = new Date('2026-01-01T00:00:00.000Z')
      const stillRunning = new Date('2026-01-01T00:00:05.000Z')
      const pastTtl = new Date('2026-01-03T00:00:00.000Z') // 48h later > 24h TTL

      expect(await store.reserveIdempotency({ scope, key, requestHash: 'hash-a', now: t0 }))
        .toEqual({ outcome: 'claimed' })
      expect((await store.reserveIdempotency({ scope, key, requestHash: 'hash-a', now: stillRunning })).outcome)
        .toBe('in_progress')
      expect((await store.reserveIdempotency({ scope, key, requestHash: 'hash-b', now: stillRunning })).outcome)
        .toBe('conflict')

      // Past the TTL the reservation is ignored, whatever hash the retry carries.
      expect((await store.reserveIdempotency({ scope, key, requestHash: 'hash-b', now: pastTtl })).outcome)
        .toBe('claimed')

      const cleanupKey = 'expiry-key-000002'
      await store.reserveIdempotency({ scope, key: cleanupKey, requestHash: 'hash-c', now: t0 })
      const removed = await store.cleanupIdempotency({ now: pastTtl })
      expect(removed).toBeGreaterThanOrEqual(1)
      expect((await store.reserveIdempotency({ scope, key: cleanupKey, requestHash: 'hash-d', now: pastTtl })).outcome)
        .toBe('claimed')
    })

    // Kept last: it fast-forwards the shared clock and expires every vault.
    it('purges expired reservations from the cron route', async () => {
      const { app, store } = ctx
      process.env.CRON_SECRET = 'cron-secret-for-tests'
      const key = 'cron-purge-key-0001'
      const expiredAt = new Date('2026-01-01T00:00:00.000Z')
      await store.reserveIdempotency({ scope: 'vault.create', key, requestHash: 'hash-x', now: expiredAt })

      const res = await request(app)
        .get(`/api/cron/expire-vaults?now=${encodeURIComponent('2030-01-01T00:00:00.000Z')}`)
        .set('Authorization', 'Bearer cron-secret-for-tests')
      expect(res.status).toBe(200)
      expect(res.body.idempotencyPurged).toBeGreaterThanOrEqual(1)

      const after = await store.reserveIdempotency({
        scope: 'vault.create',
        key,
        requestHash: 'hash-y',
        now: new Date('2030-01-01T00:00:00.000Z'),
      })
      expect(after.outcome).toBe('claimed')
    })
  })
}

defineIdempotencySuite('memory', async () => {
  const store = new MemoryStore()
  return { store, app: createApp(async () => store) }
})

if (process.env.TEST_DATABASE_URL) {
  defineIdempotencySuite('postgres', async () => {
    const fixture = await testDatabase()
    await fixture.database.migrate.latest()
    const store = new PgStore(fixture.pool)
    await store.init()
    return {
      store,
      app: createApp(async () => store),
      teardown: () => fixture.close(),
    }
  })
}

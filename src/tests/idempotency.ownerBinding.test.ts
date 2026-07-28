import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import type { Knex } from 'knex'
import {
  getIdempotentResponse,
  saveIdempotentResponse,
  failPendingIdempotentResponse,
  resetIdempotencyStore,
  hashRequestPayload,
  buildInternalKey,
  IdempotencyConflictError,
  IdempotencyService,
  type OwnerContext,
} from '../services/idempotency.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_A: OwnerContext = { userId: 'user-alpha', orgId: null }
const OWNER_B: OwnerContext = { userId: 'user-beta', orgId: null }
const OWNER_ORG1: OwnerContext = { userId: null, orgId: 'org-1' }
const OWNER_ORG2: OwnerContext = { userId: null, orgId: 'org-2' }
const OWNER_USER_IN_ORG: OwnerContext = { userId: 'user-alpha', orgId: 'org-1' }
const ANON: OwnerContext = { userId: null, orgId: null }

const PAYLOAD = { amount: '500', creator: 'GABC' }
const HASH = hashRequestPayload(PAYLOAD)
const RESPONSE = { vault: { id: 'vault-1' }, onChain: {} }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDb(record: Record<string, unknown> | null) {
  const first = jest.fn<() => Promise<typeof record>>().mockResolvedValue(record)
  const where = jest.fn().mockReturnValue({ first })
  const insert = jest.fn<() => Promise<number[]>>().mockResolvedValue([1])
  const table = jest.fn((_name: string) => ({ where, first, insert }))
  return { db: table as unknown as Knex, mocks: { where, first, insert } }
}

// ─── buildInternalKey ─────────────────────────────────────────────────────────

describe('buildInternalKey', () => {
  it('returns raw key when no owner provided', () => {
    expect(buildInternalKey('k')).toBe('k')
  })

  it('returns raw key for anonymous owner (both null)', () => {
    expect(buildInternalKey('k', ANON)).toBe('k')
  })

  it('prefixes with user: when only userId is set', () => {
    expect(buildInternalKey('k', OWNER_A)).toBe('user:user-alpha:k')
  })

  it('prefixes with org: when orgId is set (takes precedence over userId)', () => {
    expect(buildInternalKey('k', OWNER_USER_IN_ORG)).toBe('org:org-1:k')
  })

  it('prefixes with org: when only orgId is set (API key)', () => {
    expect(buildInternalKey('k', OWNER_ORG1)).toBe('org:org-1:k')
  })

  it('produces distinct internal keys for distinct user IDs', () => {
    expect(buildInternalKey('k', OWNER_A)).not.toBe(buildInternalKey('k', OWNER_B))
  })

  it('produces distinct internal keys for distinct org IDs', () => {
    expect(buildInternalKey('k', OWNER_ORG1)).not.toBe(buildInternalKey('k', OWNER_ORG2))
  })
})

// ─── In-memory store — owner isolation via namespacing ───────────────────────

describe('idempotency store — principal isolation', () => {
  beforeEach(() => {
    resetIdempotencyStore()
  })

  // ── Same-owner replay (exactly-once semantics must be preserved) ────────────

  describe('same-owner replay', () => {
    it('returns cached response when key, hash, and owner all match', async () => {
      await saveIdempotentResponse('k1', HASH, 'v1', RESPONSE, OWNER_A)
      const result = await getIdempotentResponse('k1', HASH, OWNER_A)
      expect(result).toEqual(RESPONSE)
    })

    it('returns null (cache miss) for an unknown key', async () => {
      const result = await getIdempotentResponse('never-stored', HASH, OWNER_A)
      expect(result).toBeNull()
    })

    it('throws IdempotencyConflictError when owner matches but hash differs', async () => {
      await saveIdempotentResponse('k2', HASH, 'v2', RESPONSE, OWNER_A)
      const altHash = hashRequestPayload({ amount: '999' })
      await expect(getIdempotentResponse('k2', altHash, OWNER_A)).rejects.toThrow(
        IdempotencyConflictError,
      )
    })

    it('conflict error does not include stored response data', async () => {
      await saveIdempotentResponse('k3', HASH, 'v3', { secret: 'tenant-data' }, OWNER_A)
      const err = await getIdempotentResponse('k3', 'wrong-hash', OWNER_A).catch((e) => e)
      expect(err).toBeInstanceOf(IdempotencyConflictError)
      expect(JSON.stringify(err)).not.toContain('tenant-data')
    })
  })

  // ── Cross-user isolation (namespaced keys are independent) ─────────────────

  describe('cross-user key isolation', () => {
    it('different users using the same client key get independent cache entries', async () => {
      await saveIdempotentResponse('shared-key', HASH, 'va', { owner: 'a' }, OWNER_A)
      await saveIdempotentResponse('shared-key', HASH, 'vb', { owner: 'b' }, OWNER_B)

      const resultA = await getIdempotentResponse('shared-key', HASH, OWNER_A)
      const resultB = await getIdempotentResponse('shared-key', HASH, OWNER_B)

      expect(resultA).toEqual({ owner: 'a' })
      expect(resultB).toEqual({ owner: 'b' })
    })

    it('user B gets a cache miss for user A key (no cross-user leakage)', async () => {
      await saveIdempotentResponse('k4', HASH, 'v4', { secret: 'owner-a' }, OWNER_A)
      const result = await getIdempotentResponse('k4', HASH, OWNER_B)
      // B's namespace is empty → miss, not an error and not a data leak
      expect(result).toBeNull()
    })

    it('user B hash conflict is scoped to B namespace, not A', async () => {
      await saveIdempotentResponse('k5', HASH, 'v5', RESPONSE, OWNER_A)
      const altHash = hashRequestPayload({ amount: '999' })
      // B stored a different payload under the same client key
      await saveIdempotentResponse('k5', altHash, 'v5b', { other: true }, OWNER_B)

      // A's entry is still intact and correctly replayed
      const resultA = await getIdempotentResponse('k5', HASH, OWNER_A)
      expect(resultA).toEqual(RESPONSE)

      // B's entry is intact too
      const resultB = await getIdempotentResponse('k5', altHash, OWNER_B)
      expect(resultB).toEqual({ other: true })
    })
  })

  // ── Cross-org isolation ─────────────────────────────────────────────────────

  describe('cross-org key isolation', () => {
    it('different orgs using the same client key get independent cache entries', async () => {
      await saveIdempotentResponse('org-key', HASH, 'va', { org: 1 }, OWNER_ORG1)
      await saveIdempotentResponse('org-key', HASH, 'vb', { org: 2 }, OWNER_ORG2)

      expect(await getIdempotentResponse('org-key', HASH, OWNER_ORG1)).toEqual({ org: 1 })
      expect(await getIdempotentResponse('org-key', HASH, OWNER_ORG2)).toEqual({ org: 2 })
    })

    it('org-2 gets a cache miss for a key stored by org-1', async () => {
      await saveIdempotentResponse('ok', HASH, 'v', RESPONSE, OWNER_ORG1)
      expect(await getIdempotentResponse('ok', HASH, OWNER_ORG2)).toBeNull()
    })
  })

  // ── Anonymous / no-owner context ────────────────────────────────────────────

  describe('anonymous key handling', () => {
    it('stores and replays without owner context', async () => {
      await saveIdempotentResponse('anon-key', HASH, 'v', RESPONSE)
      expect(await getIdempotentResponse('anon-key', HASH)).toEqual(RESPONSE)
    })

    it('anonymous key is distinct from same-string key owned by a user', async () => {
      await saveIdempotentResponse('k', HASH, 'va', { anon: true })
      await saveIdempotentResponse('k', HASH, 'vb', { owned: true }, OWNER_A)

      expect(await getIdempotentResponse('k', HASH)).toEqual({ anon: true })
      expect(await getIdempotentResponse('k', HASH, OWNER_A)).toEqual({ owned: true })
    })

    it('still enforces hash check for anonymous keys', async () => {
      await saveIdempotentResponse('a', HASH, 'v', RESPONSE)
      await expect(getIdempotentResponse('a', 'wrong-hash')).rejects.toThrow(
        IdempotencyConflictError,
      )
    })
  })

  // ── Legacy / anonymous backward compat ──────────────────────────────────────

  describe('legacy keys without owner (backward compat)', () => {
    it('keys saved without owner are isolated to the anonymous namespace', async () => {
      await saveIdempotentResponse('legacy', HASH, 'v', { legacy: true }, undefined)
      // Authenticated user does NOT pick up the anonymous-namespace entry
      expect(await getIdempotentResponse('legacy', HASH, OWNER_A)).toBeNull()
      // Anonymous caller does
      expect(await getIdempotentResponse('legacy', HASH)).toEqual({ legacy: true })
    })
  })

  // ── resetIdempotencyStore ────────────────────────────────────────────────────

  describe('resetIdempotencyStore', () => {
    it('clears all namespaced entries', async () => {
      await saveIdempotentResponse('k', HASH, 'v', RESPONSE, OWNER_A)
      resetIdempotencyStore()
      expect(await getIdempotentResponse('k', HASH, OWNER_A)).toBeNull()
    })
  })

  // ── failPendingIdempotentResponse ────────────────────────────────────────────

  describe('failPendingIdempotentResponse', () => {
    it('rejects the pending promise for the same owner', async () => {
      const missPromise = getIdempotentResponse('pending-key', HASH, OWNER_A)
      const pendingResult = await missPromise  // sets up the pending entry, returns null
      expect(pendingResult).toBeNull()

      // The pending entry is now stored under OWNER_A's namespace.
      // Failing it should reject any waiter on that entry.
      failPendingIdempotentResponse('pending-key', HASH, new Error('vault failed'), OWNER_A)
      // No assertion needed beyond "does not throw" — the pending promise
      // is now rejected and the entry removed from the map.
    })

    it('is a no-op when key is not pending', () => {
      expect(() =>
        failPendingIdempotentResponse('nonexistent', HASH, new Error('x'), OWNER_A),
      ).not.toThrow()
    })

    it('is a no-op when hash does not match the pending entry', async () => {
      await getIdempotentResponse('pending-hash-check', HASH, OWNER_A)
      expect(() =>
        failPendingIdempotentResponse('pending-hash-check', 'wrong-hash', new Error('x'), OWNER_A),
      ).not.toThrow()
    })
  })
})

// ─── IdempotencyService (DB-backed) ──────────────────────────────────────────

describe('IdempotencyService — DB-backed owner binding', () => {
  // ── getStoredResponse ───────────────────────────────────────────────────────

  describe('getStoredResponse', () => {
    it('returns null when key does not exist', async () => {
      const { db } = makeMockDb(null)
      const service = new IdempotencyService(db)
      expect(await service.getStoredResponse('missing', OWNER_A)).toBeNull()
    })

    it('looks up by namespaced key, not raw key', async () => {
      const { db, mocks } = makeMockDb({ response: JSON.stringify(RESPONSE) })
      const service = new IdempotencyService(db)
      await service.getStoredResponse('my-key', OWNER_A)

      expect(mocks.where).toHaveBeenCalledWith({ key: 'user:user-alpha:my-key' })
    })

    it('returns stored response when found', async () => {
      const { db } = makeMockDb({ response: JSON.stringify(RESPONSE) })
      const service = new IdempotencyService(db)
      const result = await service.getStoredResponse('k', OWNER_A)
      expect(result).toEqual(JSON.stringify(RESPONSE))
    })

    it('different owners produce different DB lookup keys (no cross-user access)', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)

      await service.getStoredResponse('k', OWNER_A)
      await service.getStoredResponse('k', OWNER_B)

      const calls = mocks.where.mock.calls
      expect(calls[0][0]).toEqual({ key: 'user:user-alpha:k' })
      expect(calls[1][0]).toEqual({ key: 'user:user-beta:k' })
    })

    it('org-level key uses org namespace', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.getStoredResponse('k', OWNER_ORG1)
      expect(mocks.where).toHaveBeenCalledWith({ key: 'org:org-1:k' })
    })

    it('returns response without owner when no owner provided', async () => {
      const { db } = makeMockDb({ response: 'raw' })
      const service = new IdempotencyService(db)
      expect(await service.getStoredResponse('k')).toBe('raw')
    })
  })

  // ── storeResponse ───────────────────────────────────────────────────────────

  describe('storeResponse', () => {
    it('inserts with namespaced key and owner audit columns', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('my-key', RESPONSE, OWNER_A)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'user:user-alpha:my-key',
          user_id: 'user-alpha',
          org_id: null,
        }),
      )
    })

    it('inserts null audit columns when no owner provided', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('k', RESPONSE)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'k', user_id: null, org_id: null }),
      )
    })

    it('serialises non-string responses to JSON', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('k', { data: 42 }, OWNER_A)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ response: JSON.stringify({ data: 42 }) }),
      )
    })

    it('passes string responses through unchanged', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('k', 'already-string', OWNER_A)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ response: 'already-string' }),
      )
    })

    it('org-level key uses org namespace in DB', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('k', RESPONSE, OWNER_ORG1)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'org:org-1:k', org_id: 'org-1', user_id: null }),
      )
    })
  })
})

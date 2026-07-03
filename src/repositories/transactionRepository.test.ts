import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import type { Knex } from 'knex'
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../tests/helpers/testDatabase.js'
import { TransactionRepository } from './transactionRepository.js'
import { encodeCursor } from '../utils/pagination.js'
import type { Transaction } from '../types/transactions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic, valid UUID from a short label so that test
 * assertions can use readable names while satisfying the `uuid` column type.
 */
const txUuid = (label: string): string => {
  const hex = Buffer.from(label).toString('hex').slice(0, 12).padEnd(12, '0')
  return `00000000-0000-0000-0000-${hex}`
}

/** Return a timestamp offset by `offsetMs` from the epoch. */
const ts = (offsetMs: number): Date => new Date(offsetMs)

interface TxSeed {
  id: string
  user_id: string
  vault_id: string
  stellar_timestamp: Date
  type?: Transaction['type']
  amount?: string
  tx_hash?: string
}

async function seedTransaction(db: Knex, tx: TxSeed): Promise<void> {
  await db('transactions').insert({
    id: tx.id,
    user_id: tx.user_id,
    vault_id: tx.vault_id,
    tx_hash: tx.tx_hash || `tx_hash_${tx.id}`,
    type: tx.type || 'creation',
    amount: tx.amount || '100.0000000',
    asset_code: 'XLM',
    from_account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    to_account: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    memo: null,
    stellar_ledger: Math.floor(Date.now() / 1000),
    stellar_timestamp: tx.stellar_timestamp,
    explorer_url: `https://stellar.expert/explorer/testnet/tx/${tx.id}`,
  })
}

async function seedUser(db: Knex, id: string, email?: string): Promise<void> {
  await db('users').insert({
    id,
    email: email || `${id}@test.com`,
    password_hash: 'hashed_pw',
  })
}

async function seedVault(
  db: Knex,
  id: string,
  userId: string,
): Promise<void> {
  await db('vaults').insert({
    id,
    creator: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    amount: '1000.0000000',
    start_date: new Date('2024-01-01'),
    end_date: new Date('2024-12-31'),
    verifier: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    success_destination:
      'GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
    failure_destination:
      'GFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    status: 'active',
    user_id: userId,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransactionRepository – Cursor Stability & Ordering', () => {
  let db: Knex
  let repo: TransactionRepository

  const USER_A = '00000000-0000-0000-0000-000000000001'
  const VAULT_A = 'vault-test-001'

  beforeAll(async () => {
    db = await setupTestDatabase()
    repo = new TransactionRepository(db)
  })

  afterAll(async () => {
    await teardownTestDatabase(db)
  })

  beforeEach(async () => {
    // Clean in FK-safe order
    await db('transactions').delete()
    await db('vaults').delete()
    await db('users').delete()

    await seedUser(db, USER_A)
    await seedVault(db, VAULT_A, USER_A)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Empty result set
  // ─────────────────────────────────────────────────────────────────────────
  describe('empty result', () => {
    it('returns empty data and has_more=false with no next_cursor', async () => {
      const result = await repo.listWithCursor(USER_A, 10)

      expect(result.data).toEqual([])
      expect(result.pagination.limit).toBe(10)
      expect(result.pagination.has_more).toBe(false)
      expect(result.pagination.next_cursor).toBeUndefined()
    })

    it('returns empty even with a stale cursor', async () => {
      const staleCursor = encodeCursor(new Date(), '00000000-0000-0000-0000-000000000000')
      const result = await repo.listWithCursor(USER_A, 10, staleCursor)

      expect(result.data).toEqual([])
      expect(result.pagination.has_more).toBe(false)
      expect(result.pagination.next_cursor).toBeUndefined()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Last-page behaviour
  // ─────────────────────────────────────────────────────────────────────────
  describe('last-page behaviour', () => {
    const ids = {
      eq0: txUuid('eq-0'),
      eq1: txUuid('eq-1'),
      eq2: txUuid('eq-2'),
      gt0: txUuid('gt-0'),
      gt1: txUuid('gt-1'),
      gt2: txUuid('gt-2'),
      gt3: txUuid('gt-3'),
      gt4: txUuid('gt-4'),
      last0: txUuid('lst0'),
      last1: txUuid('lst1'),
      last2: txUuid('lst2'),
      last3: txUuid('lst3'),
      last4: txUuid('lst4'),
    }

    it('has_more=false and no next_cursor when records equal limit', async () => {
      const t = ts(100_000)
      const data = [ids.eq0, ids.eq1, ids.eq2]
      for (let i = 0; i < data.length; i++) {
        await seedTransaction(db, {
          id: data[i],
          user_id: USER_A,
          vault_id: VAULT_A,
          stellar_timestamp: new Date(t.getTime() - i * 1000),
        })
      }

      const result = await repo.listWithCursor(USER_A, 3)

      expect(result.data).toHaveLength(3)
      expect(result.pagination.has_more).toBe(false)
      expect(result.pagination.next_cursor).toBeUndefined()
    })

    it('has_more=true and next_cursor set when records exceed limit', async () => {
      const t = ts(100_000)
      const data = [ids.gt0, ids.gt1, ids.gt2, ids.gt3, ids.gt4]
      for (let i = 0; i < data.length; i++) {
        await seedTransaction(db, {
          id: data[i],
          user_id: USER_A,
          vault_id: VAULT_A,
          stellar_timestamp: new Date(t.getTime() - i * 1000),
        })
      }

      const result = await repo.listWithCursor(USER_A, 3)

      expect(result.data).toHaveLength(3)
      expect(result.pagination.has_more).toBe(true)
      expect(result.pagination.next_cursor).toBeDefined()
      expect(typeof result.pagination.next_cursor).toBe('string')
    })

    it('has_more=false on the final page', async () => {
      const t = ts(100_000)
      const data = [ids.last0, ids.last1, ids.last2, ids.last3, ids.last4]
      for (let i = 0; i < data.length; i++) {
        await seedTransaction(db, {
          id: data[i],
          user_id: USER_A,
          vault_id: VAULT_A,
          stellar_timestamp: new Date(t.getTime() - i * 1000),
        })
      }

      // Page 1: first 3
      const page1 = await repo.listWithCursor(USER_A, 3)
      expect(page1.pagination.has_more).toBe(true)
      expect(page1.pagination.next_cursor).toBeDefined()

      // Page 2: last 2
      const page2 = await repo.listWithCursor(
        USER_A,
        3,
        page1.pagination.next_cursor!,
      )
      expect(page2.data).toHaveLength(2)
      expect(page2.pagination.has_more).toBe(false)
      expect(page2.pagination.next_cursor).toBeUndefined()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Deterministic ordering with tie-breaking on id
  // ─────────────────────────────────────────────────────────────────────────
  describe('deterministic ordering', () => {
    const ids = {
      order1: txUuid('ord-1'),
      order2: txUuid('ord-2'),
      order3: txUuid('ord-3'),
      tieA: txUuid('tie-a'),
      tieB: txUuid('tie-b'),
      tieC: txUuid('tie-c'),
      tieP1: txUuid('tieP1'),
      tieP2: txUuid('tieP2'),
      tieP3: txUuid('tieP3'),
      tieP4: txUuid('tieP4'),
    }

    it('returns results in descending stellar_timestamp order', async () => {
      await seedTransaction(db, {
        id: ids.order1,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(100_000),
      })
      await seedTransaction(db, {
        id: ids.order2,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(200_000),
      })
      await seedTransaction(db, {
        id: ids.order3,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(150_000),
      })

      const result = await repo.listWithCursor(USER_A, 10)

      expect(result.data).toHaveLength(3)
      // Most recent first
      expect(result.data[0].stellar_timestamp.getTime()).toBe(200_000)
      expect(result.data[1].stellar_timestamp.getTime()).toBe(150_000)
      expect(result.data[2].stellar_timestamp.getTime()).toBe(100_000)
    })

    it('breaks ties on stellar_timestamp by id descending', async () => {
      const sameTs = ts(300_000)
      const data = [ids.tieA, ids.tieB, ids.tieC]
      for (const id of data) {
        await seedTransaction(db, {
          id,
          user_id: USER_A,
          vault_id: VAULT_A,
          stellar_timestamp: sameTs,
        })
      }

      const result = await repo.listWithCursor(USER_A, 10)

      expect(result.data).toHaveLength(3)
      // All share the same timestamp
      const timestamps = result.data.map((d) => d.stellar_timestamp.getTime())
      expect(new Set(timestamps).size).toBe(1)

      // Must be ordered by id DESC
      const returnedIds = result.data.map((d) => d.id)
      const sortedDesc = [...data].sort((a, b) =>
        a < b ? 1 : a > b ? -1 : 0,
      )
      expect(returnedIds).toEqual(sortedDesc)
    })

    it('preserves tie-breaking order across cursor pages', async () => {
      const sameTs = ts(400_000)
      const data = [ids.tieP1, ids.tieP2, ids.tieP3, ids.tieP4]
      for (const id of data) {
        await seedTransaction(db, {
          id,
          user_id: USER_A,
          vault_id: VAULT_A,
          stellar_timestamp: sameTs,
        })
      }

      // Page 1 (limit 2)
      const page1 = await repo.listWithCursor(USER_A, 2)
      expect(page1.data).toHaveLength(2)
      expect(page1.pagination.has_more).toBe(true)

      // Page 2 using cursor
      const page2 = await repo.listWithCursor(
        USER_A,
        2,
        page1.pagination.next_cursor!,
      )
      expect(page2.data).toHaveLength(2)
      expect(page2.pagination.has_more).toBe(false)

      // No overlaps between pages
      const page1Ids = page1.data.map((d) => d.id)
      const page2Ids = page2.data.map((d) => d.id)
      const overlap = page1Ids.filter((id) => page2Ids.includes(id))
      expect(overlap).toHaveLength(0)

      // Combined results are in strict id DESC order
      const allIds = [...page1Ids, ...page2Ids]
      const sortedDesc = [...data].sort((a, b) =>
        a < b ? 1 : a > b ? -1 : 0,
      )
      expect(allIds).toEqual(sortedDesc)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // No skip/dup when rows are inserted between page fetches
  // ─────────────────────────────────────────────────────────────────────────
  describe('concurrent insert between pages', () => {
    const ids = {
      i0: txUuid('tx-i0'),
      i1: txUuid('tx-i1'),
      i2: txUuid('tx-i2'),
      i3: txUuid('tx-i3'),
      i4: txUuid('tx-i4'),
      i5: txUuid('tx-i5'),
      insert: txUuid('insert'),
      a: txUuid('tx-a-'),
      b: txUuid('tx-b-'),
      c: txUuid('tx-c-'),
    }

    it('does not skip items when a row is inserted between pages (older timestamp)', async () => {
      // Seed 6 transactions with spaced timestamps
      const base = 1_000_000
      const originalIds = [ids.i0, ids.i1, ids.i2, ids.i3, ids.i4, ids.i5]
      for (let i = 0; i < originalIds.length; i++) {
        await seedTransaction(db, {
          id: originalIds[i],
          user_id: USER_A,
          vault_id: VAULT_A,
          stellar_timestamp: ts(base - i * 10_000),
        })
      }

      // Page 1 (limit 2) → i0, i1
      const page1 = await repo.listWithCursor(USER_A, 2)
      expect(page1.data).toHaveLength(2)

      const page1Ids = page1.data.map((d) => d.id)

      // Insert a new transaction with timestamp BETWEEN i1 and i2
      await seedTransaction(db, {
        id: ids.insert,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(base - 15_000), // between i1 (base-10000) and i2 (base-20000)
      })

      // Page 2 using cursor from page 1
      const page2 = await repo.listWithCursor(
        USER_A,
        2,
        page1.pagination.next_cursor!,
      )
      const page2Ids = page2.data.map((d) => d.id)

      // No duplicates across pages
      const overlap = page1Ids.filter((id) => page2Ids.includes(id))
      expect(overlap).toHaveLength(0)

      // The newly inserted item should appear somewhere in subsequent pages
      expect(page2Ids).toContain(ids.insert)

      // Continue paginating to collect all items
      let cursor = page2.pagination.next_cursor
      const allIds = [...page1Ids, ...page2Ids]
      while (cursor) {
        const nextPage = await repo.listWithCursor(USER_A, 2, cursor)
        nextPage.data.forEach((d) => allIds.push(d.id))
        cursor = nextPage.pagination.next_cursor
      }

      // All 7 transactions (6 original + 1 inserted) should be present exactly once
      const expectedIds = [...originalIds, ids.insert]
      expect(allIds.sort()).toEqual(expectedIds.sort())
      // Verify no duplicates
      expect(new Set(allIds).size).toBe(allIds.length)
    })

    it('keeps pages consistent when insertion happens between first and second page', async () => {
      // Seed only 2 transactions; fetch page 1 (limit 1), insert one, fetch page 2
      const base = 2_000_000
      await seedTransaction(db, {
        id: ids.a,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(base),
      })
      await seedTransaction(db, {
        id: ids.b,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(base - 10_000),
      })

      // Page 1: only tx-a
      const page1 = await repo.listWithCursor(USER_A, 1)
      expect(page1.data).toHaveLength(1)
      expect(page1.data[0].id).toBe(ids.a)

      // Insert tx-c between a and b
      await seedTransaction(db, {
        id: ids.c,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(base - 5_000),
      })

      // Page 2: should include tx-c and tx-b
      const page2 = await repo.listWithCursor(
        USER_A,
        2,
        page1.pagination.next_cursor!,
      )
      expect(page2.data).toHaveLength(2)
      const page2Ids = page2.data.map((d) => d.id)
      expect(page2Ids).toContain(ids.c)
      expect(page2Ids).toContain(ids.b)

      // tx-a should NOT appear in page 2
      expect(page2Ids).not.toContain(ids.a)
    })

    it('does not duplicate items across multiple full traversals', async () => {
      const base = 3_000_000
      const count = 10
      const dupIds: string[] = []
      for (let i = 0; i < count; i++) {
        const id = txUuid(`dup-${String(i).padStart(2, '0')}`)
        dupIds.push(id)
        await seedTransaction(db, {
          id,
          user_id: USER_A,
          vault_id: VAULT_A,
          stellar_timestamp: ts(base - i * 1_000),
        })
      }

      // Full traversal collecting all ids
      const collectedIds: string[] = []
      let cursor: string | undefined

      do {
        const page = await repo.listWithCursor(USER_A, 3, cursor)
        page.data.forEach((d) => collectedIds.push(d.id))
        cursor = page.pagination.next_cursor
      } while (cursor)

      expect(collectedIds).toHaveLength(count)
      // No duplicates
      expect(new Set(collectedIds).size).toBe(count)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Cursor encoding / decoding round-trip
  // ─────────────────────────────────────────────────────────────────────────
  describe('cursor round-trip', () => {
    it('produces a stable next_cursor that can be consumed', async () => {
      const base = 5_000_000
      const rtIds: string[] = []
      for (let i = 0; i < 5; i++) {
        const id = txUuid(`rt-${i}`)
        rtIds.push(id)
        await seedTransaction(db, {
          id,
          user_id: USER_A,
          vault_id: VAULT_A,
          stellar_timestamp: ts(base - i * 1_000),
        })
      }

      const page1 = await repo.listWithCursor(USER_A, 2)
      expect(page1.pagination.next_cursor).toBeDefined()

      const page2 = await repo.listWithCursor(
        USER_A,
        10,
        page1.pagination.next_cursor!,
      )
      expect(page2.data).toHaveLength(3) // 5 total, 2 on page 1, 3 remaining
      expect(page2.pagination.has_more).toBe(false)

      // No overlap
      const allIds = [
        ...page1.data.map((d) => d.id),
        ...page2.data.map((d) => d.id),
      ]
      expect(new Set(allIds).size).toBe(5)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Filtered cursor pagination
  // ─────────────────────────────────────────────────────────────────────────
  describe('filtered cursor pagination', () => {
    const ids = {
      vaultA: txUuid('flt-va'),
      vaultB: txUuid('flt-vb'),
      typeC: txUuid('flt-tc'),
      typeR: txUuid('flt-tr'),
      fc1: txUuid('fc-01'),
      fc2: txUuid('fc-02'),
      fc3: txUuid('fc-03'),
    }

    it('applies vault_id filter during cursor pagination', async () => {
      const VAULT_B = 'vault-test-002'
      await seedVault(db, VAULT_B, USER_A)

      await seedTransaction(db, {
        id: ids.vaultA,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(6_000_000),
      })
      await seedTransaction(db, {
        id: ids.vaultB,
        user_id: USER_A,
        vault_id: VAULT_B,
        stellar_timestamp: ts(6_001_000),
      })

      // Only vault A
      const result = await repo.listWithCursor(USER_A, 10, undefined, {
        vaultId: VAULT_A,
      })
      expect(result.data).toHaveLength(1)
      expect(result.data[0].id).toBe(ids.vaultA)
    })

    it('applies type filter during cursor pagination', async () => {
      await seedTransaction(db, {
        id: ids.typeC,
        user_id: USER_A,
        vault_id: VAULT_A,
        type: 'creation',
        stellar_timestamp: ts(7_000_000),
      })
      await seedTransaction(db, {
        id: ids.typeR,
        user_id: USER_A,
        vault_id: VAULT_A,
        type: 'release',
        stellar_timestamp: ts(7_001_000),
      })

      const result = await repo.listWithCursor(USER_A, 10, undefined, {
        type: 'release',
      })
      expect(result.data).toHaveLength(1)
      expect(result.data[0].id).toBe(ids.typeR)
    })

    it('works with filters and a cursor together', async () => {
      await seedTransaction(db, {
        id: ids.fc1,
        user_id: USER_A,
        vault_id: VAULT_A,
        type: 'creation',
        stellar_timestamp: ts(8_000_000),
      })
      await seedTransaction(db, {
        id: ids.fc2,
        user_id: USER_A,
        vault_id: VAULT_A,
        type: 'creation',
        stellar_timestamp: ts(8_001_000),
      })
      await seedTransaction(db, {
        id: ids.fc3,
        user_id: USER_A,
        vault_id: VAULT_A,
        type: 'creation',
        stellar_timestamp: ts(7_999_000),
      })

      const page1 = await repo.listWithCursor(USER_A, 1, undefined, {
        type: 'creation',
      })
      expect(page1.data).toHaveLength(1)
      expect(page1.data[0].id).toBe(ids.fc2) // most recent creation

      const page2 = await repo.listWithCursor(
        USER_A,
        10,
        page1.pagination.next_cursor!,
        { type: 'creation' },
      )
      expect(page2.data).toHaveLength(2)

      const allIds = [
        ...page1.data.map((d) => d.id),
        ...page2.data.map((d) => d.id),
      ]
      expect(new Set(allIds).size).toBe(3)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // User isolation
  // ─────────────────────────────────────────────────────────────────────────
  describe('user isolation', () => {
    const USER_B = '00000000-0000-0000-0000-000000000002'
    const isoA = txUuid('iso-a')
    const isoB = txUuid('iso-b')

    beforeEach(async () => {
      await seedUser(db, USER_B, 'user-b@test.com')
      await seedVault(db, 'vault-test-b', USER_B)
    })

    it('does not return another user transactions', async () => {
      await seedTransaction(db, {
        id: isoA,
        user_id: USER_A,
        vault_id: VAULT_A,
        stellar_timestamp: ts(9_000_000),
      })
      await seedTransaction(db, {
        id: isoB,
        user_id: USER_B,
        vault_id: 'vault-test-b',
        stellar_timestamp: ts(9_001_000),
      })

      const resultA = await repo.listWithCursor(USER_A, 10)
      expect(resultA.data).toHaveLength(1)
      expect(resultA.data[0].id).toBe(isoA)

      const resultB = await repo.listWithCursor(USER_B, 10)
      expect(resultB.data).toHaveLength(1)
      expect(resultB.data[0].id).toBe(isoB)
    })
  })
})

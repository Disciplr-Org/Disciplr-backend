import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Knex } from 'knex'
import { TransactionRepository } from './transactionRepository.js'
import { setupTestDatabase, teardownTestDatabase } from '../tests/helpers/testDatabase.js'
import type { Transaction } from '../types/transactions.js'

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip

type TransactionRow = Transaction
type Predicate = (row: TransactionRow) => boolean

const userId = '00000000-0000-4000-8000-000000000101'
const otherUserId = '00000000-0000-4000-8000-000000000202'
const vaultId = 'transaction-cursor-vault'

function txId(hex: string) {
  return `00000000-0000-4000-8000-${hex.padStart(12, '0')}`
}

function asTime(iso: string) {
  return new Date(iso)
}

function compareValues(left: unknown, operator: string, right: unknown) {
  const leftValue = left instanceof Date ? left.getTime() : left
  const rightValue = right instanceof Date ? right.getTime() : right

  if (operator === '<') return leftValue < rightValue
  if (operator === '<=') return leftValue <= rightValue
  if (operator === '>=') return leftValue >= rightValue
  if (operator === '=') return leftValue === rightValue
  throw new Error(`Unsupported operator ${operator}`)
}

class FakeWhereBuilder {
  private readonly groups: Predicate[][] = [[]]

  where(criteria: Partial<TransactionRow>): this
  where(column: keyof TransactionRow, operator: string, value: unknown): this
  where(
    criteriaOrColumn: Partial<TransactionRow> | keyof TransactionRow,
    operator?: string,
    value?: unknown,
  ) {
    this.currentGroup().push(buildPredicate(criteriaOrColumn, operator, value))
    return this
  }

  andWhere(criteria: Partial<TransactionRow>): this
  andWhere(column: keyof TransactionRow, operator: string, value: unknown): this
  andWhere(
    criteriaOrColumn: Partial<TransactionRow> | keyof TransactionRow,
    operator?: string,
    value?: unknown,
  ) {
    return this.where(criteriaOrColumn as keyof TransactionRow, operator as string, value)
  }

  orWhere(callback: (this: FakeWhereBuilder) => void) {
    const nested = new FakeWhereBuilder()
    callback.call(nested)
    this.groups.push([(row) => nested.matches(row)])
    return this
  }

  matches(row: TransactionRow) {
    return this.groups.some((group) => group.every((predicate) => predicate(row)))
  }

  private currentGroup() {
    return this.groups[this.groups.length - 1]
  }
}

function buildPredicate(
  criteriaOrColumn: Partial<TransactionRow> | keyof TransactionRow,
  operator?: string,
  value?: unknown,
): Predicate {
  if (typeof criteriaOrColumn === 'object') {
    return (row) =>
      Object.entries(criteriaOrColumn).every(
        ([key, expected]) => row[key as keyof TransactionRow] === expected,
      )
  }

  return (row) => compareValues(row[criteriaOrColumn], operator ?? '=', value)
}

class FakeTransactionQuery {
  private readonly predicates: Predicate[] = []
  private readonly orderClauses: Array<{ column: keyof TransactionRow; direction: 'asc' | 'desc' }> = []
  private limitCount: number | null = null

  constructor(private readonly rows: TransactionRow[]) {}

  where(criteria: Partial<TransactionRow>): this
  where(callback: (this: FakeWhereBuilder) => void): this
  where(column: keyof TransactionRow, operator: string, value: unknown): this
  where(
    criteriaOrCallbackOrColumn:
      | Partial<TransactionRow>
      | ((this: FakeWhereBuilder) => void)
      | keyof TransactionRow,
    operator?: string,
    value?: unknown,
  ) {
    if (typeof criteriaOrCallbackOrColumn === 'function') {
      const builder = new FakeWhereBuilder()
      criteriaOrCallbackOrColumn.call(builder)
      this.predicates.push((row) => builder.matches(row))
    } else {
      this.predicates.push(buildPredicate(criteriaOrCallbackOrColumn, operator, value))
    }

    return this
  }

  orderBy(column: keyof TransactionRow, direction: 'asc' | 'desc') {
    this.orderClauses.push({ column, direction })
    return this
  }

  limit(limit: number) {
    this.limitCount = limit
    return this
  }

  then<TResult1 = TransactionRow[], TResult2 = never>(
    onfulfilled?: ((value: TransactionRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected)
  }

  private execute() {
    const sorted = this.rows
      .filter((row) => this.predicates.every((predicate) => predicate(row)))
      .sort((left, right) => {
        for (const { column, direction } of this.orderClauses) {
          const leftValue = left[column] instanceof Date ? (left[column] as Date).getTime() : left[column]
          const rightValue = right[column] instanceof Date ? (right[column] as Date).getTime() : right[column]
          if (leftValue === rightValue) continue
          const result = leftValue < rightValue ? -1 : 1
          return direction === 'asc' ? result : -result
        }

        return 0
      })

    return this.limitCount === null ? sorted : sorted.slice(0, this.limitCount)
  }
}

function createRepositoryWithRows(rows: TransactionRow[]) {
  const fakeDb = ((table: string) => {
    if (table !== 'transactions') {
      throw new Error(`Unexpected table ${table}`)
    }

    return new FakeTransactionQuery(rows)
  }) as unknown as Knex

  return new TransactionRepository(fakeDb)
}

function makeTransaction(id: string, timestamp: Date, overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id,
    user_id: userId,
    vault_id: vaultId,
    tx_hash: `hash-${id}`,
    type: 'creation',
    amount: '1.0000000',
    asset_code: 'USDC',
    from_account: 'GFROMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    to_account: 'GTOXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    memo: null,
    created_at: timestamp,
    stellar_ledger: Number.parseInt(id.slice(-4), 16),
    stellar_timestamp: timestamp,
    explorer_url: `https://stellar.expert/explorer/testnet/tx/${id}`,
    ...overrides,
  }
}

function expectNoOverlap(left: TransactionRow[], right: TransactionRow[]) {
  const leftIds = new Set(left.map((transaction) => transaction.id))
  expect(right.some((transaction) => leftIds.has(transaction.id))).toBe(false)
}

async function insertDbTransaction(db: Knex, transaction: TransactionRow) {
  await db('transactions').insert(transaction)
}

async function seedDbUserAndVault(db: Knex) {
  await db('users').insert([
    {
      id: userId,
      email: 'transaction-cursor-user@example.com',
      password_hash: 'hash',
      created_at: new Date('2030-01-01T00:00:00.000Z'),
      updated_at: new Date('2030-01-01T00:00:00.000Z'),
    },
    {
      id: otherUserId,
      email: 'transaction-cursor-other@example.com',
      password_hash: 'hash',
      created_at: new Date('2030-01-01T00:00:00.000Z'),
      updated_at: new Date('2030-01-01T00:00:00.000Z'),
    },
  ])

  await db('vaults').insert({
    id: vaultId,
    creator: userId,
    amount: '100.0000000',
    start_date: new Date('2030-01-01T00:00:00.000Z'),
    end_date: new Date('2030-12-31T00:00:00.000Z'),
    verifier: 'GVERIFIERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: 'draft',
    created_at: new Date('2030-01-01T00:00:00.000Z'),
    updated_at: new Date('2030-01-01T00:00:00.000Z'),
  })
}

function defineCursorTests(
  label: string,
  setup: () => Promise<{
    repository: TransactionRepository
    insert: (transaction: TransactionRow) => Promise<void>
  }>,
  suite = describe,
) {
  suite(label, () => {
    let repository: TransactionRepository
    let insert: (transaction: TransactionRow) => Promise<void>

    beforeEach(async () => {
      const harness = await setup()
      repository = harness.repository
      insert = harness.insert
    })

    test('does not skip or duplicate existing rows when inserts happen between pages', async () => {
      await insert(makeTransaction(txId('5'), asTime('2030-01-05T12:00:00.000Z')))
      await insert(makeTransaction(txId('4'), asTime('2030-01-05T11:00:00.000Z')))
      await insert(makeTransaction(txId('3'), asTime('2030-01-05T10:00:00.000Z')))
      await insert(makeTransaction(txId('2'), asTime('2030-01-05T09:00:00.000Z')))
      await insert(makeTransaction(txId('1'), asTime('2030-01-05T08:00:00.000Z')))

      const pageOne = await repository.listWithCursor(userId, 2)

      await insert(makeTransaction(txId('6'), asTime('2030-01-05T13:00:00.000Z')))
      await insert(makeTransaction(txId('25'), asTime('2030-01-05T09:30:00.000Z')))

      const pageTwo = await repository.listWithCursor(userId, 3, pageOne.pagination.next_cursor)

      expect(pageOne.data.map((transaction) => transaction.id)).toEqual([txId('5'), txId('4')])
      expect(pageTwo.data.map((transaction) => transaction.id)).toEqual([
        txId('3'),
        txId('25'),
        txId('2'),
      ])
      expectNoOverlap(pageOne.data, pageTwo.data)
      expect(pageTwo.data.map((transaction) => transaction.id)).not.toContain(txId('6'))
      expect(pageTwo.pagination.has_more).toBe(true)
    })

    test('orders same-timestamp rows deterministically by id descending', async () => {
      const tiedTimestamp = asTime('2030-01-05T12:00:00.000Z')
      await insert(makeTransaction(txId('a'), tiedTimestamp))
      await insert(makeTransaction(txId('c'), tiedTimestamp))
      await insert(makeTransaction(txId('b'), tiedTimestamp))

      const pageOne = await repository.listWithCursor(userId, 2)
      const pageTwo = await repository.listWithCursor(userId, 2, pageOne.pagination.next_cursor)

      expect(pageOne.data.map((transaction) => transaction.id)).toEqual([txId('c'), txId('b')])
      expect(pageTwo.data.map((transaction) => transaction.id)).toEqual([txId('a')])
      expect(pageTwo.pagination.has_more).toBe(false)
      expect(pageTwo.pagination.next_cursor).toBeUndefined()
    })

    test('returns an empty final page without cursor metadata', async () => {
      const page = await repository.listWithCursor(otherUserId, 2)

      expect(page.data).toEqual([])
      expect(page.pagination.has_more).toBe(false)
      expect(page.pagination.next_cursor).toBeUndefined()
    })

    test('marks the last page without a next cursor', async () => {
      await insert(makeTransaction(txId('3'), asTime('2030-01-05T10:00:00.000Z')))
      await insert(makeTransaction(txId('2'), asTime('2030-01-05T09:00:00.000Z')))
      await insert(makeTransaction(txId('1'), asTime('2030-01-05T08:00:00.000Z')))

      const pageOne = await repository.listWithCursor(userId, 2)
      const pageTwo = await repository.listWithCursor(userId, 2, pageOne.pagination.next_cursor)

      expect(pageOne.pagination.has_more).toBe(true)
      expect(pageOne.pagination.next_cursor).toBeDefined()
      expect(pageTwo.data.map((transaction) => transaction.id)).toEqual([txId('1')])
      expect(pageTwo.pagination.has_more).toBe(false)
      expect(pageTwo.pagination.next_cursor).toBeUndefined()
    })
  })
}

defineCursorTests('TransactionRepository cursor pagination', async () => {
  const rows: TransactionRow[] = []
  return {
    repository: createRepositoryWithRows(rows),
    insert: async (transaction) => {
      rows.push(transaction)
    },
  }
})

describeWithDatabase('TransactionRepository cursor pagination (test DB harness)', () => {
  let db: Knex

  beforeAll(async () => {
    db = await setupTestDatabase()
  })

  beforeEach(async () => {
    await db('transactions').delete()
    await db('vaults').where({ id: vaultId }).delete()
    await db('users').whereIn('id', [userId, otherUserId]).delete()
    await seedDbUserAndVault(db)
  })

  afterAll(async () => {
    if (db) {
      await db('transactions').delete()
      await db('vaults').where({ id: vaultId }).delete()
      await db('users').whereIn('id', [userId, otherUserId]).delete()
      await teardownTestDatabase(db)
    }
  })

  defineCursorTests(
    'database-backed transaction cursor contract',
    async () => ({
      repository: new TransactionRepository(db),
      insert: (transaction) => insertDbTransaction(db, transaction),
    }),
    describe,
  )
})

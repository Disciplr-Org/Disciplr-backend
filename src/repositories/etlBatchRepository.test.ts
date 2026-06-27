import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { ETLBatchRepository } from './etlBatchRepository.js'
import { setupTestDatabase, teardownTestDatabase } from '../tests/helpers/testDatabase.js'
import type { ETLBatch } from '../types/transactions.js'

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip

type BatchRow = ETLBatch

function duplicateBatchError(batchId: string) {
  const error = new Error(`duplicate key value violates unique constraint "etl_batches_pkey": ${batchId}`)
  const uniqueViolation = error as Error & { code?: string }
  uniqueViolation.code = '23505'
  return uniqueViolation
}

class FakeEtlBatchQuery {
  private insertRow: Partial<BatchRow> | null = null
  private whereClause: Partial<BatchRow> = {}

  constructor(private readonly rows: Map<string, BatchRow>) {}

  insert(row: Partial<BatchRow>) {
    this.insertRow = row
    return this
  }

  async returning() {
    if (!this.insertRow?.batch_id) {
      throw new Error('FakeEtlBatchQuery.returning called without batch_id')
    }

    const batchId = this.insertRow.batch_id
    if (this.rows.has(batchId)) {
      throw duplicateBatchError(batchId)
    }

    const row: BatchRow = {
      batch_id: batchId,
      status: 'pending',
      operations_fetched: 0,
      transactions_inserted: 0,
      transactions_skipped: 0,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      error_message: null,
      created_at: this.insertRow.created_at ?? new Date(),
      ...this.insertRow,
    } as BatchRow

    this.rows.set(batchId, row)
    return [{ ...row }]
  }

  where(criteria: Partial<BatchRow>) {
    this.whereClause = { ...this.whereClause, ...criteria }
    return this
  }

  async first() {
    return (
      Array.from(this.rows.values()).find((row) =>
        Object.entries(this.whereClause).every(([key, value]) => row[key as keyof BatchRow] === value),
      ) ?? null
    )
  }
}

function createRepositoryWithRows(rows = new Map<string, BatchRow>()) {
  const fakeDb = ((table: string) => {
    if (table !== 'etl_batches') {
      throw new Error(`Unexpected table ${table}`)
    }

    return new FakeEtlBatchQuery(rows)
  }) as unknown as Knex

  return {
    repository: new ETLBatchRepository(fakeDb),
    rows,
  }
}

function assertUniqueSuccess(results: PromiseSettledResult<ETLBatch>[]) {
  const successes = results.filter((result) => result.status === 'fulfilled')
  const failures = results.filter((result) => result.status === 'rejected')

  expect(successes).toHaveLength(1)
  expect(failures.length).toBe(results.length - 1)
  expect(failures.every((result) => result.reason instanceof Error)).toBe(true)
}

describe('ETLBatchRepository exactly-once guards', () => {
  test('create stores a new batch in pending state', async () => {
    const { repository, rows } = createRepositoryWithRows()
    const batchId = randomUUID()

    const created = await repository.create(batchId)

    expect(created.batch_id).toBe(batchId)
    expect(created.status).toBe('pending')
    expect(created.operations_fetched).toBe(0)
    expect(created.transactions_inserted).toBe(0)
    expect(created.transactions_skipped).toBe(0)
    expect(rows).toHaveProperty('size', 1)
    expect(await repository.findById(batchId)).toEqual(created)
  })

  test('create rejects a replayed batch id', async () => {
    const { repository, rows } = createRepositoryWithRows()
    const batchId = randomUUID()

    await repository.create(batchId)
    await expect(repository.create(batchId)).rejects.toThrow('duplicate key')

    expect(rows.size).toBe(1)
  })

  test('concurrent creates for the same batch id yield exactly one success', async () => {
    const { repository, rows } = createRepositoryWithRows()
    const batchId = randomUUID()

    const attempts = await Promise.allSettled(
      Array.from({ length: 24 }, () => repository.create(batchId)),
    )

    assertUniqueSuccess(attempts)
    expect(rows.size).toBe(1)
    expect(rows.get(batchId)?.batch_id).toBe(batchId)
  })
})

describeWithDatabase('ETLBatchRepository exactly-once guards (test DB harness)', () => {
  let db: Knex
  let repository: ETLBatchRepository

  beforeAll(async () => {
    db = await setupTestDatabase()
    repository = new ETLBatchRepository(db)
  })

  beforeEach(async () => {
    await db('etl_batches').delete()
  })

  afterAll(async () => {
    if (db) {
      await db('etl_batches').delete()
      await teardownTestDatabase(db)
    }
  })

  test('create stores a new batch in pending state', async () => {
    const batchId = randomUUID()

    const created = await repository.create(batchId)
    const persisted = await repository.findById(batchId)

    expect(created.batch_id).toBe(batchId)
    expect(created.status).toBe('pending')
    expect(created.operations_fetched).toBe(0)
    expect(created.transactions_inserted).toBe(0)
    expect(created.transactions_skipped).toBe(0)
    expect(persisted?.batch_id).toBe(batchId)
  })

  test('create rejects a replayed batch id', async () => {
    const batchId = randomUUID()

    await repository.create(batchId)
    await expect(repository.create(batchId)).rejects.toThrow()

    const rows = await db('etl_batches').where({ batch_id: batchId })
    expect(rows).toHaveLength(1)
  })

  test('concurrent creates for the same batch id yield exactly one success', async () => {
    const batchId = randomUUID()

    const attempts = await Promise.allSettled(
      Array.from({ length: 24 }, () => repository.create(batchId)),
    )
    const rows = await db('etl_batches').where({ batch_id: batchId })

    assertUniqueSuccess(attempts)
    expect(rows).toHaveLength(1)
  })
})

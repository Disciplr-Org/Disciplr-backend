import crypto from 'node:crypto'
import knex, { Knex } from 'knex'
import { ETLBatchRepository } from './etlBatchRepository.js'

const TEST_DB_URL = process.env.DATABASE_URL

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0')
  return `00000000-0000-4000-a000-${hex}`
}

describe('ETLBatchRepository', () => {
  let db: Knex
  let repo: ETLBatchRepository

  beforeAll(async () => {
    db = knex({
      client: 'pg',
      connection: TEST_DB_URL,
    })
    repo = new ETLBatchRepository(db)
  })

  beforeEach(async () => {
    await db('etl_batches').del()
  })

  afterAll(async () => {
    await db.destroy()
  })

  describe('create', () => {
    it('creates a new batch with pending status and zero counts', async () => {
      const id = crypto.randomUUID()
      const batch = await repo.create(id)

      expect(batch.batch_id).toBe(id)
      expect(batch.status).toBe('pending')
      expect(batch.operations_fetched).toBe(0)
      expect(batch.transactions_inserted).toBe(0)
      expect(batch.transactions_skipped).toBe(0)
      expect(batch.created_at).toBeInstanceOf(Date)
    })

    it('rejects a duplicate batch_id (exactly-once guard)', async () => {
      const id = uuid(1)
      await repo.create(id)

      await expect(repo.create(id)).rejects.toThrow()
    })

    it('allows creation after the table is cleaned', async () => {
      const id = uuid(2)
      await repo.create(id)
      await db('etl_batches').del()

      const batch = await repo.create(id)
      expect(batch.batch_id).toBe(id)
    })

    it('concurrent inserts of the same batch_id result in exactly one success', async () => {
      const CONCURRENT = 8
      const id = crypto.randomUUID()

      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENT }, () => repo.create(id)),
      )

      const succeeded = results.filter((r) => r.status === 'fulfilled')
      const failed = results.filter((r) => r.status === 'rejected')

      expect(succeeded).toHaveLength(1)
      expect(failed).toHaveLength(CONCURRENT - 1)
    })
  })

  describe('markRunning', () => {
    it('transitions a pending batch to running', async () => {
      const id = uuid(10)
      await repo.create(id)
      await repo.markRunning(id)

      const batch = await repo.findById(id)
      expect(batch!.status).toBe('running')
      expect(batch!.started_at).toBeInstanceOf(Date)
    })

    it('is a no-op if already running', async () => {
      const id = uuid(11)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markRunning(id)

      const batch = await repo.findById(id)
      expect(batch!.status).toBe('running')
    })

    it('is a no-op if already completed', async () => {
      const id = uuid(12)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markCompleted(id, {
        operationsFetched: 1,
        transactionsInserted: 1,
        transactionsSkipped: 0,
      }, 100)
      await repo.markRunning(id)

      const batch = await repo.findById(id)
      expect(batch!.status).toBe('completed')
    })
  })

  describe('markCompleted', () => {
    it('transitions to completed with counts and duration', async () => {
      const id = uuid(20)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markCompleted(id, {
        operationsFetched: 10,
        transactionsInserted: 8,
        transactionsSkipped: 2,
      }, 1500)

      const batch = await repo.findById(id)
      expect(batch!.status).toBe('completed')
      expect(batch!.operations_fetched).toBe(10)
      expect(batch!.transactions_inserted).toBe(8)
      expect(batch!.transactions_skipped).toBe(2)
      expect(batch!.duration_ms).toBe(1500)
      expect(batch!.finished_at).toBeInstanceOf(Date)
    })

    it('is a no-op if already completed (preserves first completion)', async () => {
      const id = uuid(21)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markCompleted(id, {
        operationsFetched: 5,
        transactionsInserted: 3,
        transactionsSkipped: 2,
      }, 500)
      await repo.markCompleted(id, {
        operationsFetched: 99,
        transactionsInserted: 99,
        transactionsSkipped: 0,
      }, 9999)

      const batch = await repo.findById(id)
      expect(batch!.operations_fetched).toBe(5)
      expect(batch!.transactions_inserted).toBe(3)
      expect(batch!.duration_ms).toBe(500)
    })

    it('is a no-op if already failed', async () => {
      const id = uuid(22)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markFailed(id, 'something broke', 200)
      await repo.markCompleted(id, {
        operationsFetched: 99,
        transactionsInserted: 99,
        transactionsSkipped: 0,
      }, 999)

      const batch = await repo.findById(id)
      expect(batch!.status).toBe('failed')
    })
  })

  describe('markFailed', () => {
    it('transitions to failed with error message and duration', async () => {
      const id = uuid(30)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markFailed(id, 'connection timeout', 3000)

      const batch = await repo.findById(id)
      expect(batch!.status).toBe('failed')
      expect(batch!.error_message).toBe('connection timeout')
      expect(batch!.duration_ms).toBe(3000)
      expect(batch!.finished_at).toBeInstanceOf(Date)
    })

    it('is a no-op if already completed', async () => {
      const id = uuid(31)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markCompleted(id, {
        operationsFetched: 1,
        transactionsInserted: 1,
        transactionsSkipped: 0,
      }, 100)
      await repo.markFailed(id, 'too late', 200)

      const batch = await repo.findById(id)
      expect(batch!.status).toBe('completed')
    })
  })

  describe('isCompleted', () => {
    it('returns true for a completed batch', async () => {
      const id = uuid(40)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markCompleted(id, {
        operationsFetched: 0,
        transactionsInserted: 0,
        transactionsSkipped: 0,
      }, 0)

      expect(await repo.isCompleted(id)).toBe(true)
    })

    it('returns false for a non-existent batch', async () => {
      const id = crypto.randomUUID()
      expect(await repo.isCompleted(id)).toBe(false)
    })

    it('returns false for a pending batch', async () => {
      const id = uuid(41)
      await repo.create(id)
      expect(await repo.isCompleted(id)).toBe(false)
    })

    it('returns false for a failed batch', async () => {
      const id = uuid(42)
      await repo.create(id)
      await repo.markRunning(id)
      await repo.markFailed(id, 'err', 100)

      expect(await repo.isCompleted(id)).toBe(false)
    })
  })

  describe('findById', () => {
    it('returns the batch when it exists', async () => {
      const id = uuid(50)
      await repo.create(id)
      const batch = await repo.findById(id)

      expect(batch).not.toBeNull()
      expect(batch!.batch_id).toBe(id)
    })

    it('returns null when the batch does not exist', async () => {
      const id = crypto.randomUUID()
      const batch = await repo.findById(id)
      expect(batch).toBeNull()
    })
  })

  describe('listRecent', () => {
    it('returns batches ordered by created_at descending', async () => {
      const id1 = uuid(60)
      const id2 = uuid(61)
      const id3 = uuid(62)
      await repo.create(id1)
      await repo.create(id2)
      await repo.create(id3)

      const batches = await repo.listRecent(10)
      expect(batches).toHaveLength(3)
      expect(batches[0].batch_id).toBe(id3)
      expect(batches[1].batch_id).toBe(id2)
      expect(batches[2].batch_id).toBe(id1)
    })

    it('respects the limit parameter', async () => {
      await repo.create(uuid(70))
      await repo.create(uuid(71))
      await repo.create(uuid(72))

      const batches = await repo.listRecent(2)
      expect(batches).toHaveLength(2)
    })
  })
})

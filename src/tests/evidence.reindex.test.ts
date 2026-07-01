import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import {
  reindexEvidenceBatch,
  runReindexBatches,
  EMBEDDING_REINDEX_JOB_NAME,
  type MilestoneEmbeddingSource,
  type ReindexCursorStore,
} from '../services/evidenceReindex.js'
import { DeterministicEmbeddingProvider, createEmbeddingProvider } from '../services/embeddingProvider.js'
import { MilestoneRepository } from '../repositories/milestoneRepository.js'
import { BackfillCursorStore } from '../services/backfillCursorStore.js'
import { getEmbeddingReindexProgress, resetEmbeddingReindexProgress } from '../services/dbMetrics.js'

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakeMilestoneRow {
  id: string
  title: string
  description: string | null
}

interface FakeEmbeddingRow {
  modelVersion: string
  embedding: number[]
}

class FakeMilestoneSource implements MilestoneEmbeddingSource {
  embeddings = new Map<string, FakeEmbeddingRow>()
  upsertCalls: Array<{ milestoneId: string; modelVersion: string }> = []

  constructor(private readonly milestones: FakeMilestoneRow[]) {}

  async listMilestonesAfter(afterId: string | null, limit: number): Promise<FakeMilestoneRow[]> {
    const sorted = [...this.milestones].sort((a, b) => a.id.localeCompare(b.id))
    const filtered = afterId === null ? sorted : sorted.filter((m) => m.id > afterId)
    return filtered.slice(0, limit)
  }

  async findEmbeddingModelVersions(milestoneIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    for (const id of milestoneIds) {
      const existing = this.embeddings.get(id)
      if (existing) {
        result.set(id, existing.modelVersion)
      }
    }
    return result
  }

  async upsertEmbedding(milestoneId: string, embedding: number[], modelVersion: string): Promise<void> {
    this.embeddings.set(milestoneId, { embedding, modelVersion })
    this.upsertCalls.push({ milestoneId, modelVersion })
  }
}

class FakeCursorStore implements ReindexCursorStore {
  private cursors = new Map<string, string | null>()

  async getCursor(jobName: string): Promise<string | null> {
    return this.cursors.get(jobName) ?? null
  }

  async upsertCursor(jobName: string, cursor: string | null): Promise<void> {
    this.cursors.set(jobName, cursor)
  }
}

const makeMilestones = (count: number): FakeMilestoneRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m-${String(i).padStart(3, '0')}`,
    title: `Milestone ${i}`,
    description: `Description for milestone ${i}`,
  }))

const provider = new DeterministicEmbeddingProvider('v1')

// ── reindexEvidenceBatch ─────────────────────────────────────────────────────

describe('reindexEvidenceBatch', () => {
  it('does nothing and reports done on an empty table', async () => {
    const source = new FakeMilestoneSource([])
    const cursorStore = new FakeCursorStore()

    const result = await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider })

    expect(result).toEqual({ processed: 0, reindexed: 0, skippedUpToDate: 0, cursor: null, done: true })
  })

  it('generates embeddings for every milestone missing one', async () => {
    const source = new FakeMilestoneSource(makeMilestones(3))
    const cursorStore = new FakeCursorStore()

    const result = await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider, batchSize: 10 })

    expect(result.processed).toBe(3)
    expect(result.reindexed).toBe(3)
    expect(result.skippedUpToDate).toBe(0)
    expect(result.done).toBe(true)
    expect(source.upsertCalls.map((c) => c.milestoneId)).toEqual(['m-000', 'm-001', 'm-002'])
    expect(source.upsertCalls.every((c) => c.modelVersion === 'v1')).toBe(true)
  })

  it('only reindexes rows whose model version differs from the current model', async () => {
    const source = new FakeMilestoneSource(makeMilestones(3))
    await source.upsertEmbedding('m-000', [0.1], 'v1') // already current
    await source.upsertEmbedding('m-001', [0.2], 'legacy-unversioned') // stale
    // m-002 has no embedding at all (missing)
    source.upsertCalls.length = 0 // discard the seeding calls above
    const cursorStore = new FakeCursorStore()

    const result = await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider, batchSize: 10 })

    expect(result.skippedUpToDate).toBe(1)
    expect(result.reindexed).toBe(2)
    expect(source.upsertCalls.map((c) => c.milestoneId).sort()).toEqual(['m-001', 'm-002'])
  })

  it('persists the cursor as the last milestone id seen in the batch', async () => {
    const source = new FakeMilestoneSource(makeMilestones(5))
    const cursorStore = new FakeCursorStore()

    const result = await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider, batchSize: 2 })

    expect(result.processed).toBe(2)
    expect(result.cursor).toBe('m-001')
    expect(result.done).toBe(false) // batch was full; more rows may remain
    expect(await cursorStore.getCursor(EMBEDDING_REINDEX_JOB_NAME)).toBe('m-001')
  })

  it('resumes from the persisted cursor after a simulated crash, without reprocessing earlier rows', async () => {
    const source = new FakeMilestoneSource(makeMilestones(5))
    const cursorStore = new FakeCursorStore()

    const firstBatch = await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider, batchSize: 2 })
    expect(firstBatch.cursor).toBe('m-001')

    // Simulate a crash: a brand-new call only has access to what's durable —
    // the cursor store and the source — not any in-process state.
    const secondBatch = await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider, batchSize: 2 })

    expect(secondBatch.processed).toBe(2)
    expect(source.upsertCalls.map((c) => c.milestoneId)).toEqual(['m-000', 'm-001', 'm-002', 'm-003'])
    expect(secondBatch.cursor).toBe('m-003')
    expect(secondBatch.done).toBe(false)

    const thirdBatch = await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider, batchSize: 2 })
    expect(thirdBatch.processed).toBe(1)
    expect(thirdBatch.done).toBe(true)
    expect(thirdBatch.cursor).toBe('m-004')
  })

  it('rate-limits successive embedding calls but never sleeps before the first or after a skip-only batch', async () => {
    const source = new FakeMilestoneSource(makeMilestones(3))
    const cursorStore = new FakeCursorStore()
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)

    await reindexEvidenceBatch({
      source,
      cursorStore,
      embeddingProvider: provider,
      batchSize: 10,
      rateLimitMs: 25,
      sleep,
    })

    // 3 rows reindexed -> 2 inter-call delays, never a delay before the first call.
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(25)
  })

  it('never sleeps when every row in the batch is already up to date', async () => {
    const source = new FakeMilestoneSource(makeMilestones(2))
    await source.upsertEmbedding('m-000', [0.1], 'v1')
    await source.upsertEmbedding('m-001', [0.2], 'v1')
    source.upsertCalls.length = 0 // discard the seeding calls above
    const cursorStore = new FakeCursorStore()
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)

    const result = await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider, sleep })

    expect(result.reindexed).toBe(0)
    expect(result.skippedUpToDate).toBe(2)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('records progress metrics consumable via dbMetrics', async () => {
    resetEmbeddingReindexProgress()
    expect(getEmbeddingReindexProgress()).toBeNull()

    const source = new FakeMilestoneSource(makeMilestones(1))
    const cursorStore = new FakeCursorStore()

    await reindexEvidenceBatch({ source, cursorStore, embeddingProvider: provider })

    const progress = getEmbeddingReindexProgress()
    expect(progress).not.toBeNull()
    expect(progress).toMatchObject({ processed: 1, reindexed: 1, modelVersion: 'v1', done: true })
    expect(progress!.recordedAt).toBeInstanceOf(Date)
  })
})

// ── runReindexBatches ────────────────────────────────────────────────────────

describe('runReindexBatches', () => {
  it('runs multiple batches until the table is fully caught up', async () => {
    const source = new FakeMilestoneSource(makeMilestones(5))
    const cursorStore = new FakeCursorStore()

    const result = await runReindexBatches({
      source,
      cursorStore,
      embeddingProvider: provider,
      batchSize: 2,
      maxBatchesPerRun: 10,
    })

    expect(result.batches).toBe(3) // 2 + 2 + 1
    expect(result.processed).toBe(5)
    expect(result.reindexed).toBe(5)
    expect(result.done).toBe(true)
  })

  it('stops after maxBatchesPerRun even if more rows remain', async () => {
    const source = new FakeMilestoneSource(makeMilestones(10))
    const cursorStore = new FakeCursorStore()

    const result = await runReindexBatches({
      source,
      cursorStore,
      embeddingProvider: provider,
      batchSize: 2,
      maxBatchesPerRun: 2,
    })

    expect(result.batches).toBe(2)
    expect(result.processed).toBe(4)
    expect(result.done).toBe(false)
    expect(result.cursor).toBe('m-003')
  })
})

// ── MilestoneRepository — reindex support (mocked Knex) ────────────────────

function makeQueryBuilder(rows: unknown[] = []) {
  const qb: any = {
    select: jest.fn<any>().mockReturnThis(),
    orderBy: jest.fn<any>().mockReturnThis(),
    limit: jest.fn<any>().mockReturnThis(),
    where: jest.fn<any>().mockReturnThis(),
    whereIn: jest.fn<any>().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => resolve(rows),
  }
  return qb
}

function makeMockDb(qb: ReturnType<typeof makeQueryBuilder>) {
  const db: any = jest.fn<any>().mockReturnValue(qb)
  db.raw = jest.fn<any>().mockResolvedValue(undefined)
  return db
}

describe('MilestoneRepository — reindex support', () => {
  it('listMilestonesAfter queries without a lower bound when afterId is null', async () => {
    const qb = makeQueryBuilder([{ id: 'm-000', title: 'A', description: null }])
    const db = makeMockDb(qb)
    const repo = new MilestoneRepository(db)

    const rows = await repo.listMilestonesAfter(null, 50)

    expect(db).toHaveBeenCalledWith('milestones')
    expect(qb.where).not.toHaveBeenCalled()
    expect(qb.limit).toHaveBeenCalledWith(50)
    expect(rows).toEqual([{ id: 'm-000', title: 'A', description: null }])
  })

  it('listMilestonesAfter filters by id > afterId when a cursor is given', async () => {
    const qb = makeQueryBuilder([])
    const db = makeMockDb(qb)
    const repo = new MilestoneRepository(db)

    await repo.listMilestonesAfter('m-005', 25)

    expect(qb.where).toHaveBeenCalledWith('id', '>', 'm-005')
    expect(qb.limit).toHaveBeenCalledWith(25)
  })

  it('findEmbeddingModelVersions returns an empty map without querying when given no ids', async () => {
    const qb = makeQueryBuilder([])
    const db = makeMockDb(qb)
    const repo = new MilestoneRepository(db)

    const result = await repo.findEmbeddingModelVersions([])

    expect(result.size).toBe(0)
    expect(db).not.toHaveBeenCalled()
  })

  it('findEmbeddingModelVersions maps milestone_id to model_version', async () => {
    const qb = makeQueryBuilder([
      { milestone_id: 'm-000', model_version: 'v1' },
      { milestone_id: 'm-001', model_version: 'legacy-unversioned' },
    ])
    const db = makeMockDb(qb)
    const repo = new MilestoneRepository(db)

    const result = await repo.findEmbeddingModelVersions(['m-000', 'm-001', 'm-002'])

    expect(qb.whereIn).toHaveBeenCalledWith('milestone_id', ['m-000', 'm-001', 'm-002'])
    expect(result.get('m-000')).toBe('v1')
    expect(result.get('m-001')).toBe('legacy-unversioned')
    expect(result.has('m-002')).toBe(false)
  })

  it('upsertEmbedding passes the model version through to the raw insert', async () => {
    const db: any = jest.fn<any>()
    db.raw = jest.fn<any>().mockResolvedValue(undefined)
    const repo = new MilestoneRepository(db)

    await repo.upsertEmbedding('m-000', [0.1, 0.2], 'custom-model-v2')

    expect(db.raw).toHaveBeenCalledWith(
      expect.stringContaining('model_version'),
      expect.objectContaining({ milestoneId: 'm-000', modelVersion: 'custom-model-v2' }),
    )
  })

  it('upsertEmbedding defaults to the current configured model version', async () => {
    const db: any = jest.fn<any>()
    db.raw = jest.fn<any>().mockResolvedValue(undefined)
    const repo = new MilestoneRepository(db)

    await repo.upsertEmbedding('m-000', [0.1])

    expect(db.raw).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ modelVersion: 'deterministic-v1' }),
    )
  })

  it('findEmbedding includes model_version in the returned record', async () => {
    const qb = makeQueryBuilder([])
    qb.select = jest.fn<any>().mockReturnThis()
    qb.first = jest
      .fn<any>()
      .mockResolvedValue({
        milestone_id: 'm-000',
        embedding: '[0.1,0.2]',
        model_version: 'v1',
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
      })
    const db = makeMockDb(qb)
    const repo = new MilestoneRepository(db)

    const result = await repo.findEmbedding('m-000')

    expect(qb.select).toHaveBeenCalledWith(
      'milestone_id',
      expect.anything(),
      'model_version',
      'created_at',
      'updated_at',
    )
    expect(result).toMatchObject({ milestone_id: 'm-000', model_version: 'v1', embedding: [0.1, 0.2] })
  })

  it('findEmbedding returns null when no row exists', async () => {
    const qb = makeQueryBuilder([])
    qb.select = jest.fn<any>().mockReturnThis()
    qb.first = jest.fn<any>().mockResolvedValue(null)
    const db = makeMockDb(qb)
    const repo = new MilestoneRepository(db)

    const result = await repo.findEmbedding('missing')

    expect(result).toBeNull()
  })
})

// ── embeddingProvider ────────────────────────────────────────────────────────

describe('createEmbeddingProvider', () => {
  it('uses the given model version and produces a normalised vector', async () => {
    const created = createEmbeddingProvider('test-model')
    expect(created.modelVersion).toBe('test-model')

    const embedding = await created.embed('hello world')
    expect(embedding).toHaveLength(768)
    const norm = Math.sqrt(embedding.reduce((acc, v) => acc + v * v, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('falls back to the configured CURRENT_EMBEDDING_MODEL_VERSION when none is given', () => {
    const created = createEmbeddingProvider()
    expect(created.modelVersion).toBe('deterministic-v1')
  })
})

// ── BackfillCursorStore (mocked Knex) ───────────────────────────────────────

function makeCursorQueryBuilder(overrides: Partial<Record<string, any>> = {}) {
  const qb: any = {
    where: jest.fn<any>().mockReturnThis(),
    first: jest.fn<any>().mockResolvedValue(null),
    insert: jest.fn<any>().mockReturnThis(),
    onConflict: jest.fn<any>().mockReturnThis(),
    merge: jest.fn<any>().mockResolvedValue(undefined),
    delete: jest.fn<any>().mockResolvedValue(1),
    ...overrides,
  }
  return qb
}

function makeCursorMockDb(qb: ReturnType<typeof makeCursorQueryBuilder>) {
  const db: any = jest.fn<any>().mockReturnValue(qb)
  db._qb = qb
  return db
}

describe('BackfillCursorStore', () => {
  it('getCursor returns null when no row exists', async () => {
    const qb = makeCursorQueryBuilder({ first: jest.fn<any>().mockResolvedValue(null) })
    const db = makeCursorMockDb(qb)
    const store = new BackfillCursorStore(db)

    const result = await store.getCursor('my-job')

    expect(result).toBeNull()
    expect(db).toHaveBeenCalledWith('backfill_cursors')
    expect(qb.where).toHaveBeenCalledWith({ job_name: 'my-job' })
  })

  it('getCursor returns the stored cursor when a row exists', async () => {
    const qb = makeCursorQueryBuilder({ first: jest.fn<any>().mockResolvedValue({ cursor: 'm-042' }) })
    const db = makeCursorMockDb(qb)
    const store = new BackfillCursorStore(db)

    const result = await store.getCursor('my-job')

    expect(result).toBe('m-042')
  })

  it('upsertCursor inserts with onConflict merge', async () => {
    const qb = makeCursorQueryBuilder()
    const db = makeCursorMockDb(qb)
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('my-job', 'm-099')

    expect(qb.insert).toHaveBeenCalledWith(
      expect.objectContaining({ job_name: 'my-job', cursor: 'm-099' }),
    )
    expect(qb.onConflict).toHaveBeenCalledWith('job_name')
    expect(qb.merge).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'm-099' }))
  })

  it('resetCursor deletes the row for the job', async () => {
    const qb = makeCursorQueryBuilder()
    const db = makeCursorMockDb(qb)
    const store = new BackfillCursorStore(db)

    await store.resetCursor('my-job')

    expect(qb.where).toHaveBeenCalledWith({ job_name: 'my-job' })
    expect(qb.delete).toHaveBeenCalled()
  })
})

// ── createDefaultJobHandlers — embeddings.reindex ───────────────────────────

describe('embeddings.reindex job handler', () => {
  let createDefaultJobHandlers: any

  beforeEach(async () => {
    const module = await import('../jobs/handlers.js')
    createDefaultJobHandlers = module.createDefaultJobHandlers
  })

  it('runs the reindex against the injected dependencies and completes', async () => {
    const source = new FakeMilestoneSource(makeMilestones(2))
    const cursorStore = new FakeCursorStore()
    const handlers = createDefaultJobHandlers(
      { send: jest.fn() },
      { source, cursorStore, embeddingProvider: provider },
    )

    await handlers['embeddings.reindex']({}, { jobId: 'job-1', attempt: 1 })

    expect(source.upsertCalls).toHaveLength(2)
  })
})

import type { EmbeddingProvider } from './embeddingProvider.js'
import { recordEmbeddingReindexProgress } from './dbMetrics.js'

export const EMBEDDING_REINDEX_JOB_NAME = 'milestone-evidence-embedding-reindex'

export interface MilestoneEmbeddingSource {
  listMilestonesAfter(
    afterId: string | null,
    limit: number,
  ): Promise<Array<{ id: string; title: string; description: string | null }>>
  findEmbeddingModelVersions(milestoneIds: string[]): Promise<Map<string, string>>
  upsertEmbedding(milestoneId: string, embedding: number[], modelVersion: string): Promise<void>
}

/**
 * Narrow, structural view of BackfillCursorStore (see backfillCursorStore.ts)
 * — declared as an interface rather than imported as the concrete class so
 * tests can inject a lightweight in-memory fake instead of a real Knex-backed
 * store.
 */
export interface ReindexCursorStore {
  getCursor(jobName: string): Promise<string | null>
  upsertCursor(jobName: string, cursor: string | null): Promise<void>
}

export interface ReindexBatchOptions {
  source: MilestoneEmbeddingSource
  cursorStore: ReindexCursorStore
  embeddingProvider: EmbeddingProvider
  batchSize?: number
  rateLimitMs?: number
  jobName?: string
  sleep?: (ms: number) => Promise<void>
}

export interface ReindexBatchResult {
  processed: number
  reindexed: number
  skippedUpToDate: number
  cursor: string | null
  done: boolean
}

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_RATE_LIMIT_MS = 50

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const buildEmbeddingText = (milestone: { title: string; description: string | null }): string =>
  [milestone.title, milestone.description].filter(Boolean).join('\n')

/**
 * Process a single bounded page of the milestones table, (re)generating any
 * embedding that is missing or whose model_version no longer matches the
 * currently configured embedding model. Resumable: the cursor is the last
 * milestone id seen, persisted via `cursorStore` so a crash or restart picks
 * up after this batch instead of reprocessing already-current rows.
 */
export async function reindexEvidenceBatch(options: ReindexBatchOptions): Promise<ReindexBatchResult> {
  const {
    source,
    cursorStore,
    embeddingProvider,
    batchSize = DEFAULT_BATCH_SIZE,
    rateLimitMs = DEFAULT_RATE_LIMIT_MS,
    jobName = EMBEDDING_REINDEX_JOB_NAME,
    sleep = defaultSleep,
  } = options

  const cursor = await cursorStore.getCursor(jobName)
  const milestones = await source.listMilestonesAfter(cursor, batchSize)

  if (milestones.length === 0) {
    const result: ReindexBatchResult = { processed: 0, reindexed: 0, skippedUpToDate: 0, cursor, done: true }
    recordEmbeddingReindexProgress({ ...result, modelVersion: embeddingProvider.modelVersion })
    return result
  }

  const existingVersions = await source.findEmbeddingModelVersions(milestones.map((m) => m.id))

  let reindexed = 0
  let skippedUpToDate = 0

  for (const milestone of milestones) {
    const existingVersion = existingVersions.get(milestone.id) ?? null
    if (existingVersion === embeddingProvider.modelVersion) {
      skippedUpToDate += 1
      continue
    }

    if (reindexed > 0) {
      await sleep(rateLimitMs)
    }

    const text = buildEmbeddingText(milestone)
    const embedding = await embeddingProvider.embed(text)
    await source.upsertEmbedding(milestone.id, embedding, embeddingProvider.modelVersion)
    reindexed += 1
  }

  const newCursor = milestones[milestones.length - 1].id
  await cursorStore.upsertCursor(jobName, newCursor)

  const result: ReindexBatchResult = {
    processed: milestones.length,
    reindexed,
    skippedUpToDate,
    cursor: newCursor,
    done: milestones.length < batchSize,
  }
  recordEmbeddingReindexProgress({ ...result, modelVersion: embeddingProvider.modelVersion })
  return result
}

export interface ReindexRunOptions extends ReindexBatchOptions {
  maxBatchesPerRun?: number
}

export interface ReindexRunResult {
  batches: number
  processed: number
  reindexed: number
  skippedUpToDate: number
  cursor: string | null
  done: boolean
}

const DEFAULT_MAX_BATCHES_PER_RUN = 5

/**
 * Run up to `maxBatchesPerRun` batches in sequence, stopping early once the
 * table is fully caught up. Intended to be invoked periodically (e.g. by a
 * recurring job) rather than run to completion in one call, so a single
 * invocation never blocks the worker for an unbounded amount of time.
 */
export async function runReindexBatches(options: ReindexRunOptions): Promise<ReindexRunResult> {
  const { maxBatchesPerRun = DEFAULT_MAX_BATCHES_PER_RUN, ...batchOptions } = options

  const totals: ReindexRunResult = {
    batches: 0,
    processed: 0,
    reindexed: 0,
    skippedUpToDate: 0,
    cursor: null,
    done: false,
  }

  for (let i = 0; i < maxBatchesPerRun; i++) {
    const batch = await reindexEvidenceBatch(batchOptions)
    totals.batches += 1
    totals.processed += batch.processed
    totals.reindexed += batch.reindexed
    totals.skippedUpToDate += batch.skippedUpToDate
    totals.cursor = batch.cursor
    totals.done = batch.done

    if (batch.done) {
      break
    }
  }

  return totals
}

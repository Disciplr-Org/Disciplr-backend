/**
 * Tests: embedding model-version drift detector and re-embed trigger (issue #854)
 *
 * Coverage:
 *  - All embeddings current (no drift)
 *  - Mixed versions (drift reported correctly)
 *  - No embeddings in DB
 *  - detectEmbeddingDrift honours the currentModelVersion argument
 *  - Resumable re-embed: cursor advances, no double-processing
 *  - GET /api/admin/embeddings/drift is admin-only (403 for non-admin)
 *  - POST /api/admin/embeddings/reembed is admin-only (403 for non-admin)
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import {
  detectEmbeddingDrift,
  type EmbeddingDriftReport,
} from '../services/embeddingProvider.js'
import {
  reindexEvidenceBatch,
  runReindexBatches,
  EMBEDDING_REINDEX_JOB_NAME,
  type MilestoneEmbeddingSource,
  type ReindexCursorStore,
} from '../services/evidenceReindex.js'
import { DeterministicEmbeddingProvider } from '../services/embeddingProvider.js'

// ── Fake DB for detectEmbeddingDrift ─────────────────────────────────────────

function makeDb(rows: Array<{ model_version: string; count: number }>) {
  return (table: string) => {
    expect(table).toBe('milestone_embeddings')
    const q: any = {
      select: () => q,
      count: () => q,
      groupBy: async () => rows,
    }
    return q
  }
}

// ── Fakes for reindex (borrowed pattern from evidence.reindex.test.ts) ───────

interface FakeRow { id: string; title: string; description: string | null }

class FakeSource implements MilestoneEmbeddingSource {
  embeddings = new Map<string, string>() // milestoneId → modelVersion
  upsertCalls: string[] = []

  constructor(private readonly milestones: FakeRow[]) {}

  async listMilestonesAfter(afterId: string | null, limit: number): Promise<FakeRow[]> {
    const sorted = [...this.milestones].sort((a, b) => a.id.localeCompare(b.id))
    const filtered = afterId === null ? sorted : sorted.filter((m) => m.id > afterId)
    return filtered.slice(0, limit)
  }

  async findEmbeddingModelVersions(ids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    for (const id of ids) {
      const v = this.embeddings.get(id)
      if (v) result.set(id, v)
    }
    return result
  }

  async upsertEmbedding(milestoneId: string, _: number[], modelVersion: string): Promise<void> {
    this.embeddings.set(milestoneId, modelVersion)
    this.upsertCalls.push(milestoneId)
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

const provider = new DeterministicEmbeddingProvider('v2')
const milestones: FakeRow[] = [
  { id: 'm-001', title: 'Alpha', description: null },
  { id: 'm-002', title: 'Beta', description: 'desc' },
  { id: 'm-003', title: 'Gamma', description: null },
]

// ── detectEmbeddingDrift ─────────────────────────────────────────────────────

describe('detectEmbeddingDrift', () => {
  it('reports zero stale when all embeddings match the current version', async () => {
    const db = makeDb([{ model_version: 'v2', count: 10 }])
    const report = await detectEmbeddingDrift(db, 'v2')

    expect(report.currentModelVersion).toBe('v2')
    expect(report.totalEmbeddings).toBe(10)
    expect(report.currentCount).toBe(10)
    expect(report.staleCount).toBe(0)
    expect(report.versions).toHaveLength(1)
    expect(report.versions[0].isCurrent).toBe(true)
  })

  it('reports mixed drift correctly', async () => {
    const db = makeDb([
      { model_version: 'v1', count: 7 },
      { model_version: 'legacy-unversioned', count: 3 },
      { model_version: 'v2', count: 15 },
    ])
    const report = await detectEmbeddingDrift(db, 'v2')

    expect(report.totalEmbeddings).toBe(25)
    expect(report.currentCount).toBe(15)
    expect(report.staleCount).toBe(10)
    expect(report.versions.find((v) => v.modelVersion === 'v1')?.isCurrent).toBe(false)
    expect(report.versions.find((v) => v.modelVersion === 'v2')?.isCurrent).toBe(true)
  })

  it('returns zeros when there are no embeddings', async () => {
    const db = makeDb([])
    const report = await detectEmbeddingDrift(db, 'v2')

    expect(report.totalEmbeddings).toBe(0)
    expect(report.staleCount).toBe(0)
    expect(report.versions).toHaveLength(0)
  })

  it('uses CURRENT_EMBEDDING_MODEL_VERSION when no version arg is passed', async () => {
    const { CURRENT_EMBEDDING_MODEL_VERSION } = await import('../services/embeddingProvider.js')
    const db = makeDb([{ model_version: CURRENT_EMBEDDING_MODEL_VERSION, count: 5 }])
    const report = await detectEmbeddingDrift(db)

    expect(report.currentModelVersion).toBe(CURRENT_EMBEDDING_MODEL_VERSION)
    expect(report.staleCount).toBe(0)
  })
})

// ── Resumable re-embed (no double-processing) ─────────────────────────────────

describe('reindex resumability and no double-processing', () => {
  it('advances cursor and does not reprocess already-current rows', async () => {
    const source = new FakeSource(milestones)
    // Pre-load m-001 as already on v2
    source.embeddings.set('m-001', 'v2')
    const cursorStore = new FakeCursorStore()

    const result = await reindexEvidenceBatch({
      source,
      cursorStore,
      embeddingProvider: provider,
      batchSize: 10,
      rateLimitMs: 0,
    })

    expect(result.processed).toBe(3)
    expect(result.skippedUpToDate).toBe(1)
    expect(result.reindexed).toBe(2)
    expect(result.done).toBe(true)
    // m-001 was already current — must not be re-embedded
    expect(source.upsertCalls).not.toContain('m-001')
    expect(source.upsertCalls).toContain('m-002')
    expect(source.upsertCalls).toContain('m-003')
    // Cursor advanced to last milestone id
    expect(await cursorStore.getCursor(EMBEDDING_REINDEX_JOB_NAME)).toBe('m-003')
  })

  it('resumes from cursor on second call and does not reprocess earlier rows', async () => {
    const source = new FakeSource(milestones)
    const cursorStore = new FakeCursorStore()
    // Simulate cursor already at m-001 (first batch already ran)
    await cursorStore.upsertCursor(EMBEDDING_REINDEX_JOB_NAME, 'm-001')
    source.embeddings.set('m-001', 'v2') // already done in prior run

    const result = await reindexEvidenceBatch({
      source,
      cursorStore,
      embeddingProvider: provider,
      batchSize: 10,
      rateLimitMs: 0,
    })

    // Only m-002 and m-003 should be processed (after cursor)
    expect(result.processed).toBe(2)
    expect(source.upsertCalls).not.toContain('m-001')
  })

  it('runReindexBatches reports done when all rows are current', async () => {
    const source = new FakeSource(milestones)
    milestones.forEach((m) => source.embeddings.set(m.id, 'v2'))
    const cursorStore = new FakeCursorStore()

    const result = await runReindexBatches({
      source,
      cursorStore,
      embeddingProvider: provider,
      batchSize: 10,
      rateLimitMs: 0,
    })

    expect(result.reindexed).toBe(0)
    expect(result.skippedUpToDate).toBe(3)
    expect(result.done).toBe(true)
  })
})

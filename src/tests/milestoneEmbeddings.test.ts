/**
 * Tests for MilestoneRepository – pgvector-backed nearest-neighbour search.
 *
 * These tests require a live PostgreSQL instance with the pgvector extension
 * installed.  When pgvector is unavailable (e.g. in CI without a pg service,
 * or when DATABASE_URL is not set) the suite is skipped automatically so it
 * never blocks a build.
 *
 * To run locally:
 *   DATABASE_URL=postgres://... npm test -- milestoneEmbeddings
 */

import knex, { Knex } from 'knex'
import { MilestoneRepository } from '../repositories/milestoneRepository.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVector(seed: number, dims = 768): number[] {
  // Deterministic pseudo-random vector seeded by `seed`.
  const v: number[] = []
  let s = seed
  for (let i = 0; i < dims; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    v.push((s & 0xffff) / 0xffff - 0.5)
  }
  // L2-normalise so cosine distance reflects angle only.
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0))
  return v.map((x) => x / norm)
}

const MILESTONE_IDS = ['m-001', 'm-002', 'm-003', 'm-004', 'm-005']

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Knex
let repo: MilestoneRepository
let pgvectorAvailable = false

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    return // will be skipped below
  }

  db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    acquireConnectionTimeout: 5000,
  })

  try {
    // Check whether the vector extension exists.
    const result = await db.raw(
      `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
    )
    pgvectorAvailable = result.rows.length > 0
  } catch {
    pgvectorAvailable = false
    return
  }

  if (!pgvectorAvailable) return

  // Ensure the table exists for tests (mirrors the migration).
  await db.raw('CREATE EXTENSION IF NOT EXISTS vector')
  await db.schema.createTableIfNotExists('milestone_embeddings', (t) => {
    t.uuid('milestone_id').primary()
    t.specificType('embedding', 'vector(768)').notNullable()
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
  })

  repo = new MilestoneRepository(db)

  // Clean up any leftover rows from a previous run.
  await db('milestone_embeddings').whereIn('milestone_id', MILESTONE_IDS).delete()
})

afterAll(async () => {
  if (db) {
    if (pgvectorAvailable) {
      await db('milestone_embeddings').whereIn('milestone_id', MILESTONE_IDS).delete()
    }
    await db.destroy()
  }
})

// Utility: skip individual tests when pgvector is not available.
function itWhenPgvector(name: string, fn: () => Promise<void>) {
  if (!process.env.DATABASE_URL || !pgvectorAvailable) {
    it.skip(name, fn)
  } else {
    it(name, fn)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MilestoneRepository – pgvector', () => {
  itWhenPgvector('upsertEmbedding inserts a new record', async () => {
    await repo.upsertEmbedding('m-001', makeVector(1))
    const row = await repo.findEmbedding('m-001')
    expect(row).not.toBeNull()
    expect(row!.milestone_id).toBe('m-001')
    expect(row!.embedding).toHaveLength(768)
  })

  itWhenPgvector('upsertEmbedding overwrites an existing record', async () => {
    const v1 = makeVector(1)
    const v2 = makeVector(99)
    await repo.upsertEmbedding('m-001', v1)
    await repo.upsertEmbedding('m-001', v2)
    const row = await repo.findEmbedding('m-001')
    // After upsert the first dimension should match v2, not v1.
    expect(row!.embedding[0]).toBeCloseTo(v2[0], 5)
  })

  itWhenPgvector('nearestNeighbors returns empty array when milestone has no embedding', async () => {
    const results = await repo.nearestNeighbors('does-not-exist')
    expect(results).toEqual([])
  })

  itWhenPgvector('nearestNeighbors excludes the queried milestone from results', async () => {
    // Seed several embeddings.
    for (let i = 0; i < MILESTONE_IDS.length; i++) {
      await repo.upsertEmbedding(MILESTONE_IDS[i], makeVector(i + 1))
    }

    const results = await repo.nearestNeighbors('m-001', 10)
    const ids = results.map((r) => r.milestone_id)
    expect(ids).not.toContain('m-001')
  })

  itWhenPgvector('nearestNeighbors respects the k limit', async () => {
    for (let i = 0; i < MILESTONE_IDS.length; i++) {
      await repo.upsertEmbedding(MILESTONE_IDS[i], makeVector(i + 1))
    }

    const results = await repo.nearestNeighbors('m-001', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  itWhenPgvector('nearestNeighbors results are ordered by ascending distance', async () => {
    for (let i = 0; i < MILESTONE_IDS.length; i++) {
      await repo.upsertEmbedding(MILESTONE_IDS[i], makeVector(i + 1))
    }

    const results = await repo.nearestNeighbors('m-001', 4)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance)
    }
  })

  itWhenPgvector('nearestNeighbors distance is between 0 and 2 (cosine)', async () => {
    for (let i = 0; i < MILESTONE_IDS.length; i++) {
      await repo.upsertEmbedding(MILESTONE_IDS[i], makeVector(i + 1))
    }

    const results = await repo.nearestNeighbors('m-001', 5)
    for (const r of results) {
      expect(r.distance).toBeGreaterThanOrEqual(0)
      expect(r.distance).toBeLessThanOrEqual(2)
    }
  })

  itWhenPgvector('identical vectors have distance ≈ 0', async () => {
    const v = makeVector(42)
    await repo.upsertEmbedding('m-001', v)
    await repo.upsertEmbedding('m-002', v)

    const results = await repo.nearestNeighbors('m-001', 1)
    expect(results[0].milestone_id).toBe('m-002')
    expect(results[0].distance).toBeCloseTo(0, 4)
  })

  itWhenPgvector('deleteEmbedding removes the record', async () => {
    await repo.upsertEmbedding('m-001', makeVector(1))
    await repo.deleteEmbedding('m-001')
    const row = await repo.findEmbedding('m-001')
    expect(row).toBeNull()
  })

  itWhenPgvector('findEmbedding returns null for unknown milestone', async () => {
    const row = await repo.findEmbedding('non-existent-id')
    expect(row).toBeNull()
  })
})

import { prisma } from '../lib/prisma.js'
import { findSimilar } from '../services/evidence.js'
import crypto from 'crypto'

function makeVector(seed: number, dims = 768): number[] {
  const v: number[] = []
  let s = seed
  for (let i = 0; i < dims; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    v.push((s & 0xffff) / 0xffff - 0.5)
  }
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0))
  return v.map((x) => x / norm)
}

describe('Evidence Similarity Search', () => {
  let pgvectorAvailable = false
  let vaultId: string
  const milestoneIds: string[] = []

  beforeAll(async () => {
    try {
      const result = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
      if (Array.isArray(result) && result.length > 0) {
        pgvectorAvailable = true
      }
    } catch {
      pgvectorAvailable = false
      return
    }

    if (!pgvectorAvailable) return

    // Run migrations just in case
    await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS vector`
    await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS pg_trgm`

    // Setup user and vault
    const verifierId = 'test-verifier-user'
    await prisma.$executeRaw`
      INSERT INTO verifiers (user_id, status, display_name) 
      VALUES (${verifierId}, 'approved', 'Test Verifier') 
      ON CONFLICT (user_id) DO NOTHING
    `

    vaultId = crypto.randomUUID()
    await prisma.$executeRaw`
      INSERT INTO vaults (id, name, created_at, updated_at) 
      VALUES (${vaultId}, 'Test Vault', NOW(), NOW())
    `

    // Setup dummy evidence (query + 4 targets)
    const datasets = [
      { seed: 1, hash: 'hash-abc', url: 'https://example.com/doc1' }, // Query milestone
      { seed: 1, hash: 'hash-xyz', url: 'https://example.com/doc2' }, // Very similar vector, different text
      { seed: 9, hash: 'hash-abc', url: 'https://example.com/doc1' }, // Different vector, exact same text
      { seed: 8, hash: 'hash-123', url: 'https://example.com/other' }, // completely different
      { seed: 2, hash: 'hash-abd', url: 'https://example.com/doc1-edit' }, // Similar vector, similar text
    ]

    for (const data of datasets) {
      const mId = crypto.randomUUID()
      milestoneIds.push(mId)
      
      await prisma.$executeRaw`
        INSERT INTO milestones (id, vault_id, title, type, criteria, status, created_at, updated_at)
        VALUES (${mId}, ${vaultId}, 'Test Milestone', 'test', '{}', 'pending', NOW(), NOW())
      `

      const vec = `[${makeVector(data.seed).join(',')}]`
      await prisma.$executeRaw`
        INSERT INTO milestone_embeddings (milestone_id, embedding, created_at, updated_at)
        VALUES (${mId}, ${vec}::vector, NOW(), NOW())
      `

      const vId = crypto.randomUUID()
      await prisma.$executeRaw`
        INSERT INTO verifications (id, verifier_user_id, target_id, result)
        VALUES (${vId}, ${verifierId}, ${mId}, 'approved')
      `

      await prisma.$executeRaw`
        INSERT INTO evidence_references (verification_id, evidence_hash, reference_url, expires_at, created_at)
        VALUES (${vId}, ${data.hash}, ${data.url}, NOW() + INTERVAL '1 day', NOW())
      `
    }
  })

  afterAll(async () => {
    if (pgvectorAvailable && milestoneIds.length > 0) {
      // Clean up
      for (const mId of milestoneIds) {
        await prisma.$executeRaw`DELETE FROM evidence_references WHERE verification_id IN (SELECT id FROM verifications WHERE target_id = ${mId})`
        await prisma.$executeRaw`DELETE FROM verifications WHERE target_id = ${mId}`
        await prisma.$executeRaw`DELETE FROM milestone_embeddings WHERE milestone_id = ${mId}`
        await prisma.$executeRaw`DELETE FROM milestones WHERE id = ${mId}`
      }
      await prisma.$executeRaw`DELETE FROM vaults WHERE id = ${vaultId}`
    }
    await prisma.$disconnect()
  })

  function itWhenPgvector(name: string, fn: () => Promise<void>) {
    if (!pgvectorAvailable) {
      it.skip(name, fn)
    } else {
      it(name, fn)
    }
  }

  itWhenPgvector('returns near-duplicate evidence (keyword + vector matching)', async () => {
    const queryMilestoneId = milestoneIds[0]
    const results = await findSimilar(queryMilestoneId)

    expect(results.length).toBeGreaterThan(0)
    
    // Exact text match (datasets[2]) should rank highly because keywordDistance = 0
    const exactTextMatch = results.find(r => r.milestoneId === milestoneIds[2])
    expect(exactTextMatch).toBeDefined()
    expect(exactTextMatch!.keywordDistance).toBeCloseTo(0)

    // Exact vector match (datasets[1]) should rank highly because vectorDistance = 0
    const exactVectorMatch = results.find(r => r.milestoneId === milestoneIds[1])
    expect(exactVectorMatch).toBeDefined()
    expect(exactVectorMatch!.vectorDistance).toBeCloseTo(0)

    // Check that fused score orders correctly
    for (let i = 1; i < results.length; i++) {
      expect(results[i].fusedScore).toBeGreaterThanOrEqual(results[i - 1].fusedScore)
    }
  })

  itWhenPgvector('can weight vector similarity over keyword similarity', async () => {
    const queryMilestoneId = milestoneIds[0]
    const results = await findSimilar(queryMilestoneId, { vectorWeight: 1.0, keywordWeight: 0.0 })
    
    // If only vector is weighted, the exact vector match (index 1) should be #1
    expect(results[0].milestoneId).toBe(milestoneIds[1])
  })

  itWhenPgvector('can weight keyword similarity over vector similarity', async () => {
    const queryMilestoneId = milestoneIds[0]
    const results = await findSimilar(queryMilestoneId, { vectorWeight: 0.0, keywordWeight: 1.0 })
    
    // If only keyword is weighted, the exact keyword match (index 2) should be #1
    expect(results[0].milestoneId).toBe(milestoneIds[2])
  })

  itWhenPgvector('stays under a latency budget of 50ms', async () => {
    const queryMilestoneId = milestoneIds[0]
    
    const start = performance.now()
    await findSimilar(queryMilestoneId)
    const end = performance.now()
    
    // Latency
    expect(end - start).toBeLessThan(50) // 50ms budget
  })
})

/**
 * Migration: HNSW index for vectors and pg_trgm for evidence text similarity
 */

exports.up = async function (knex) {
  // Enable pg_trgm for keyword similarity
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm')

  // Guard: skip the vector index if the milestone_embeddings table does not
  // exist (e.g. when pgvector extension is unavailable and the table was
  // never created — see 20260602000000_create_milestone_embeddings.cjs).
  const hasEmbeddingsTable = await knex.schema.hasTable('milestone_embeddings')
  if (hasEmbeddingsTable) {
    // Drop the old ivfflat index
    await knex.raw('DROP INDEX IF EXISTS idx_milestone_embeddings_vector')

    // Create HNSW index for better recall/latency tradeoffs
    // Using m=16, ef_construction=64 as standard defaults for 768-dim embeddings
    await knex.raw(`
      CREATE INDEX idx_milestone_embeddings_hnsw
        ON milestone_embeddings
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    `)
  }

  // Create GIN indexes on evidence_references for text similarity search
  await knex.raw(`
    CREATE INDEX idx_evidence_refs_url_trgm
      ON evidence_references
      USING gin (reference_url gin_trgm_ops)
  `)

  await knex.raw(`
    CREATE INDEX idx_evidence_refs_hash_trgm
      ON evidence_references
      USING gin (evidence_hash gin_trgm_ops)
  `)
}

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_evidence_refs_hash_trgm')
  await knex.raw('DROP INDEX IF EXISTS idx_evidence_refs_url_trgm')

  const hasEmbeddingsTable = await knex.schema.hasTable('milestone_embeddings')
  if (hasEmbeddingsTable) {
    await knex.raw('DROP INDEX IF EXISTS idx_milestone_embeddings_hnsw')

    // Restore the ivfflat index
    await knex.raw(`
      CREATE INDEX idx_milestone_embeddings_vector
        ON milestone_embeddings
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    `)
  }
}

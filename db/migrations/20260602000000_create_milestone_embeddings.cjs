/**
 * Migration: pgvector extension + milestone_embeddings table
 *
 * Enables the pgvector extension and creates the milestone_embeddings table
 * used for near-duplicate / low-effort submission detection via cosine-
 * similarity search over 768-dimensional embedding vectors.
 */

exports.config = { transaction: false }

exports.up = async function up(knex) {
  // Enable pgvector; idempotent – safe to run repeatedly.
  // If pgvector is not installed on the server, skip gracefully.
  let hasVector = false
  try {
    await knex.raw('CREATE EXTENSION IF NOT EXISTS vector')
    hasVector = true
  } catch (err) {
    console.warn(
      'pgvector extension is not available — skipping milestone_embeddings table creation.',
      err.message,
    )
  }

  if (!hasVector) return

  await knex.schema.createTable('milestone_embeddings', (table) => {
    table.uuid('milestone_id').primary()
    // vector(768) is a pgvector column type; Knex does not have a native
    // helper for it, so we use a raw column definition.
    table.specificType('embedding', 'vector(768)').notNullable()
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updated_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now())
  })

  // IVFFlat index for approximate nearest-neighbour search (cosine distance).
  // lists=100 is a reasonable default for tables up to ~1 M rows.
  await knex.raw(`
    CREATE INDEX idx_milestone_embeddings_vector
      ON milestone_embeddings
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
  `)
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('milestone_embeddings')
  // Leave the vector extension in place – other tables may rely on it.
}

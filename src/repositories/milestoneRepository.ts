import { Knex } from 'knex'
import { CURRENT_EMBEDDING_MODEL_VERSION } from '../services/embeddingProvider.js'

export interface MilestoneEmbedding {
  milestone_id: string
  embedding: number[]
  model_version: string
  created_at: Date
  updated_at: Date
}

export interface NearestNeighborResult {
  milestone_id: string
  distance: number
}

export interface MilestoneSummary {
  id: string
  title: string
  description: string | null
}

/**
 * Repository for milestone embedding operations backed by pgvector.
 *
 * All vector values are 768-dimensional float arrays matching the
 * `vector(768)` column type in the milestone_embeddings table.
 */
export class MilestoneRepository {
  constructor(private readonly db: Knex) {}

  /**
   * Upsert an embedding for a milestone.
   * Replaces any existing embedding (and model_version) for the same milestone_id.
   */
  async upsertEmbedding(
    milestoneId: string,
    embedding: number[],
    modelVersion: string = CURRENT_EMBEDDING_MODEL_VERSION,
  ): Promise<void> {
    const vectorLiteral = `[${embedding.join(',')}]`
    await this.db.raw(
      `INSERT INTO milestone_embeddings (milestone_id, embedding, model_version, updated_at)
       VALUES (:milestoneId, :vector::vector, :modelVersion, NOW())
       ON CONFLICT (milestone_id)
       DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, updated_at = NOW()`,
      { milestoneId, vector: vectorLiteral, modelVersion },
    )
  }

  /**
   * Find the k nearest neighbours to the embedding stored for milestoneId,
   * ordered by ascending cosine distance (closest first).
   *
   * The queried milestone itself is excluded from the results.
   *
   * @param milestoneId  The milestone whose stored embedding is used as the query vector.
   * @param k            Maximum number of neighbours to return (default: 5).
   * @returns            Array of { milestone_id, distance } sorted closest-first.
   *                     Returns an empty array when no embedding exists for milestoneId.
   */
  async nearestNeighbors(milestoneId: string, k = 5): Promise<NearestNeighborResult[]> {
    // Fetch the query embedding first so we can pass it as a plain literal.
    // This avoids a correlated sub-query that would prevent index use.
    const row = await this.db('milestone_embeddings')
      .where({ milestone_id: milestoneId })
      .select(this.db.raw('embedding::text AS embedding_text'))
      .first()

    if (!row) return []

    const rows = await this.db.raw<{ rows: { milestone_id: string; distance: string }[] }>(
      `SELECT milestone_id,
              (embedding <=> :queryVec::vector) AS distance
       FROM   milestone_embeddings
       WHERE  milestone_id <> :milestoneId
       ORDER  BY embedding <=> :queryVec::vector
       LIMIT  :k`,
      { queryVec: row.embedding_text, milestoneId, k },
    )

    return rows.rows.map((r) => ({
      milestone_id: r.milestone_id,
      distance: parseFloat(r.distance),
    }))
  }

  /**
   * Return the stored embedding record for a milestone, or null if absent.
   */
  async findEmbedding(milestoneId: string): Promise<MilestoneEmbedding | null> {
    const row = await this.db('milestone_embeddings')
      .where({ milestone_id: milestoneId })
      .select(
        'milestone_id',
        this.db.raw('embedding::text AS embedding'),
        'model_version',
        'created_at',
        'updated_at',
      )
      .first()

    if (!row) return null

    return {
      ...row,
      embedding: JSON.parse(row.embedding) as number[],
    } as MilestoneEmbedding
  }

  /**
   * Delete the embedding for a milestone (e.g. when the milestone is removed).
   */
  async deleteEmbedding(milestoneId: string): Promise<void> {
    await this.db('milestone_embeddings').where({ milestone_id: milestoneId }).delete()
  }

  /**
   * Page through the milestones table in stable ascending-id order. Used by
   * the embedding reindex backfill to walk the source-of-truth table without
   * loading it all into memory at once.
   */
  async listMilestonesAfter(afterId: string | null, limit: number): Promise<MilestoneSummary[]> {
    let query = this.db('milestones')
      .select('id', 'title', 'description')
      .orderBy('id', 'asc')
      .limit(limit)

    if (afterId !== null) {
      query = query.where('id', '>', afterId)
    }

    return query
  }

  /**
   * Return the model_version of every embedding that exists among the given
   * milestone ids. Ids absent from the returned map have no stored embedding.
   */
  async findEmbeddingModelVersions(milestoneIds: string[]): Promise<Map<string, string>> {
    if (milestoneIds.length === 0) {
      return new Map()
    }

    const rows = await this.db('milestone_embeddings')
      .whereIn('milestone_id', milestoneIds)
      .select('milestone_id', 'model_version')

    return new Map(rows.map((row: { milestone_id: string; model_version: string }) => [row.milestone_id, row.model_version]))
  }
}

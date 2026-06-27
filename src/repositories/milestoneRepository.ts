import { Knex } from 'knex'

export interface MilestoneEmbedding {
  milestone_id: string
  embedding: number[]
  created_at: Date
  updated_at: Date
}

export interface NearestNeighborResult {
  milestone_id: string
  distance: number
}

export interface MilestoneQueryOptions {
  includeDeleted?: boolean
}

export interface MilestoneRecord {
  id: string
  vaultId: string
  title: string
  description: string | null
  dueDate: string
  amount: string
  sortOrder: number
  verifierUserId: string | null
  createdAt: string
  deletedAt: string | null
}

type MilestoneRow = {
  id: string
  vault_id: string
  title: string
  description: string | null
  due_date: string
  amount: string
  sort_order: number
  verifier_user_id: string | null
  created_at: string
  deleted_at: string | null
}

const mapMilestoneRow = (row: MilestoneRow): MilestoneRecord => ({
  id: row.id,
  vaultId: row.vault_id,
  title: row.title,
  description: row.description,
  dueDate: row.due_date,
  amount: row.amount,
  sortOrder: row.sort_order,
  verifierUserId: row.verifier_user_id,
  createdAt: row.created_at,
  deletedAt: row.deleted_at,
})

/**
 * Repository for milestone embedding operations backed by pgvector.
 *
 * All vector values are 768-dimensional float arrays matching the
 * `vector(768)` column type in the milestone_embeddings table.
 */
export class MilestoneRepository {
  constructor(private readonly db: Knex) {}

  private selectMilestones() {
    return this.db<MilestoneRow>('milestones').select(
      'id',
      'vault_id',
      'title',
      'description',
      'due_date',
      this.db.raw('amount::text AS amount'),
      'sort_order',
      'verifier_user_id',
      'created_at',
      'deleted_at',
    )
  }

  /**
   * List milestones for a vault, excluding soft-deleted rows by default.
   */
  async listByVaultId(
    vaultId: string,
    options: MilestoneQueryOptions = {},
  ): Promise<MilestoneRecord[]> {
    const query = this.selectMilestones()
      .where({ vault_id: vaultId })
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')

    if (!options.includeDeleted) {
      query.whereNull('deleted_at')
    }

    const rows = await query
    return (rows as unknown as MilestoneRow[]).map(mapMilestoneRow)
  }

  /**
   * List milestones assigned to a verifier, excluding soft-deleted rows by default.
   */
  async listByVerifierUserId(
    verifierUserId: string,
    options: MilestoneQueryOptions = {},
  ): Promise<MilestoneRecord[]> {
    const query = this.selectMilestones()
      .where({ verifier_user_id: verifierUserId })
      .orderBy('created_at', 'asc')
      .orderBy('sort_order', 'asc')

    if (!options.includeDeleted) {
      query.whereNull('deleted_at')
    }

    const rows = await query
    return (rows as unknown as MilestoneRow[]).map(mapMilestoneRow)
  }

  /**
   * Upsert an embedding for a milestone.
   * Replaces any existing embedding for the same milestone_id.
   */
  async upsertEmbedding(milestoneId: string, embedding: number[]): Promise<void> {
    const vectorLiteral = `[${embedding.join(',')}]`
    await this.db.raw(
      `INSERT INTO milestone_embeddings (milestone_id, embedding, updated_at)
       VALUES (:milestoneId, :vector::vector, NOW())
       ON CONFLICT (milestone_id)
       DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = NOW()`,
      { milestoneId, vector: vectorLiteral },
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
}

import { Knex } from "knex";
import { CURRENT_EMBEDDING_MODEL_VERSION } from "../services/embeddingProvider.js";

const EMBEDDING_DIMENSIONS = 768;
const MAX_NEIGHBOR_COUNT = 100;
const MAX_PAGE_SIZE = 100;
const MAX_BATCH_IDS = 1000;

function normalizePageSize(limit: number | undefined, fallback = 10): number {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.min(MAX_PAGE_SIZE, fallback);
  }
  return Math.min(MAX_PAGE_SIZE, Math.trunc(parsed));
}

export interface MilestoneEmbedding {
  milestone_id: string;
  embedding: number[];
  model_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface NearestNeighborResult {
  milestone_id: string;
  distance: number;
}

export interface MilestoneSummary {
  id: string;
  title: string;
  description: string | null;
}

/**
 * Minimal milestone row for soft-delete / verifier-assignment lookups.
 * Includes the columns needed to verify query correctness without
 * leaking the full vault_PAYLOAD.
 */
export interface MilestoneLookup {
  id: string;
  vault_id: string;
  title: string;
  description: string | null;
  verifier_user_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface MilestoneQueryOptions {
  /**
   * When true, soft-deleted milestones (`deleted_at IS NOT NULL`) are also
   * returned. Defaults to `false` so callers always operate on active rows.
   */
  includeDeleted?: boolean;
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
    if (!milestoneId) {
      throw new Error("Invariant violation: milestoneId is required");
    }
    if (
      !Array.isArray(embedding) ||
      embedding.length !== EMBEDDING_DIMENSIONS ||
      !embedding.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      throw new Error(
        `Invariant violation: Embedding must be a ${EMBEDDING_DIMENSIONS}-dimensional float array`,
      );
    }
    const vectorLiteral = `[${embedding.join(",")}]`;
    await this.db.raw(
      `INSERT INTO milestone_embeddings (milestone_id, embedding, model_version, updated_at)
       VALUES (:milestoneId, :vector::vector, :modelVersion, NOW())
       ON CONFLICT (milestone_id)
       DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, updated_at = NOW()`,
      { milestoneId, vector: vectorLiteral, modelVersion },
    );
  }

  /**
   * Find the k nearest neighbours to the embedding stored for milestoneId,
   * ordered by ascending cosine distance (closest first).
   *
   * The queried milestone itself is excluded from the results.
   *
   * @param milestoneId  The milestone whose stored embedding is used as the query vector.
   * @param k            Maximum number of neighbours to return (default: 5, capped at 100).
   * @returns            Array of { milestone_id, distance } sorted closest-first.
   *                     Returns an empty array when no embedding exists for milestoneId.
   */
  async nearestNeighbors(
    milestoneId: string,
    k = 5,
  ): Promise<NearestNeighborResult[]> {
    if (!milestoneId) {
      throw new Error("Invariant violation: milestoneId is required");
    }
    // Cap k so callers cannot inflate a top-k vector lookup into an unbounded LIMIT.
    const cappedK = Math.min(MAX_NEIGHBOR_COUNT, Math.max(1, Math.trunc(Number(k)) || 5));

    // Fetch the query embedding first so we can pass it as a plain literal.
    // This avoids a correlated sub-query that would prevent index use.
    const row = (await this.db("milestone_embeddings")
      .where({ milestone_id: milestoneId })
      .select(this.db.raw("embedding::text AS embedding_text"))
      .first()) as any;

    if (!row) return [];

    const rows = await this.db.raw<{
      rows: { milestone_id: string; distance: string }[];
    }>(
      `SELECT milestone_id,
              (embedding <=> :queryVec::vector) AS distance
       FROM   milestone_embeddings
       WHERE  milestone_id <> :milestoneId
       ORDER  BY embedding <=> :queryVec::vector
       LIMIT  :k`,
      { queryVec: row.embedding_text, milestoneId, k: cappedK },
    );

    return rows.rows.map((r) => ({
      milestone_id: r.milestone_id,
      distance: parseFloat(r.distance),
    }));
  }

  /**
   * Return the stored embedding record for a milestone, or null if absent.
   */
  async findEmbedding(milestoneId: string): Promise<MilestoneEmbedding | null> {
    if (!milestoneId) {
      throw new Error("Invariant violation: milestoneId is required");
    }
    const row = await this.db("milestone_embeddings")
      .where({ milestone_id: milestoneId })
      .select(
        "milestone_id",
        this.db.raw("embedding::text AS embedding"),
        "model_version",
        "created_at",
        "updated_at",
      )
      .first();

    if (!row) return null;

    return {
      ...row,
      embedding: JSON.parse(row.embedding) as number[],
    } as MilestoneEmbedding;
  }

  /**
   * Delete the embedding for a milestone (e.g. when the milestone is removed).
   */
  async deleteEmbedding(milestoneId: string): Promise<void> {
    if (!milestoneId) {
      throw new Error("Invariant violation: milestoneId is required");
    }
    await this.db("milestone_embeddings")
      .where({ milestone_id: milestoneId })
      .delete();
  }

  /**
   * Page through the milestones table in stable ascending-id order. Used by
   * the embedding reindex backfill to walk the source-of-truth table without
   * loading it all into memory at once.
   *
   * NOTE: The reindex job intentionally walks every row — including
   * soft-deleted ones — because the embedding for a soft-deleted milestone
   * may still need to be cleaned up.  Callers that want soft-delete filtering
   * should use `findById` or `listForVerifier`.
   */
  async listMilestonesAfter(
    afterId: string | null,
    limit: number,
  ): Promise<MilestoneSummary[]> {
    const pageSize = normalizePageSize(limit);
    let query = this.db("milestones")
      .select("id", "title", "description")
      .orderBy("id", "asc")
      .limit(pageSize);

    if (afterId !== null) {
      query = query.where("id", ">", afterId);
    }

    return query;
  }

  /**
   * Resolve a single milestone by id, excluding soft-deleted rows by default.
   *
   * The `verifier_user_id` linkage added by
   * `db/migrations/20260428140504_add_verifier_user_id_to_milestones.cjs`
   * and the `deleted_at` column added by
   * `db/migrations/20260602125638_add_soft_delete_to_vaults_and_milestones.cjs`
   * are both considered. A regression in either filter would be invisible in
   * production until a leaked milestone surfaces downstream — the accompanying
   * tests pin the contract.
   */
  async findById(
    id: string,
    opts: MilestoneQueryOptions = {},
  ): Promise<MilestoneLookup | null> {
    const includeDeleted = opts.includeDeleted === true;
    let query = this.db("milestones")
      .where({ id })
      .select(
        "id",
        "vault_id",
        "title",
        "description",
        "verifier_user_id",
        "deleted_at",
        "created_at",
      )
      .first();

    if (!includeDeleted) {
      query = query.whereNull("deleted_at");
    }

    // Knex's `.first()` resolves to `undefined` when nothing matches; the
    // contract for this method is `null`.
    return (await query) ?? null;
  }

  /**
   * List every milestone currently assigned to a verifier, excluding
   * soft-deleted rows by default.
   *
   * This query is the primary defence against leaking a milestone to a
   * verifier who is not its assigned owner. The result set is always
   * restricted to the verifier's actual assignments.
   */
  async listForVerifier(
    verifierUserId: string,
    opts: MilestoneQueryOptions = {},
  ): Promise<MilestoneLookup[]> {
    const includeDeleted = opts.includeDeleted === true;
    let query = this.db("milestones")
      .where({ verifier_user_id: verifierUserId })
      .select(
        "id",
        "vault_id",
        "title",
        "description",
        "verifier_user_id",
        "deleted_at",
        "created_at",
      )
      .orderBy("id", "asc");

    if (!includeDeleted) {
      query = query.whereNull("deleted_at");
    }

    return query;
  }

  /**
   * Soft-delete a single milestone by stamping `deleted_at`. Returns true if
   * a row was updated, false if the id was unknown or already soft-deleted.
   *
   * The accompanying test pins both branches and the round-trip with
   * `restore()` so that the deleted-then-restored path can never silently
   * leave a milestone invisible to default reads.
   */
  async softDelete(id: string, deletedAt: Date = new Date()): Promise<boolean> {
    if (!id) throw new Error("Invariant violation: id is required");
    const updated = await this.db("milestones")
      .where({ id })
      .whereNull("deleted_at")
      .update({ deleted_at: deletedAt, updated_at: new Date() });

    return updated > 0;
  }

  /**
   * Restore a soft-deleted milestone by clearing its `deleted_at`. Returns
   * true if a row was updated, false if the id was unknown or never
   * soft-deleted.
   */
  async restore(id: string): Promise<boolean> {
    if (!id) throw new Error("Invariant violation: id is required");
    const updated = await this.db("milestones")
      .where({ id })
      .whereNotNull("deleted_at")
      .update({ deleted_at: null, updated_at: new Date() });

    return updated > 0;
  }

  /**
   * Return the model_version of every embedding that exists among the given
   * milestone ids. Ids absent from the returned map have no stored embedding.
   */
  async findEmbeddingModelVersions(
    milestoneIds: string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(milestoneIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    if (uniqueIds.length > MAX_BATCH_IDS) {
      throw new Error(
        `Invariant violation: milestoneIds must contain at most ${MAX_BATCH_IDS} unique entries`,
      );
    }

    const rows = await this.db("milestone_embeddings")
      .whereIn("milestone_id", uniqueIds)
      .select("milestone_id", "model_version");

    return new Map(
      rows.map((row: { milestone_id: string; model_version: string }) => [
        row.milestone_id,
        row.model_version,
      ]),
    );
  }

  /**
   * Find milestones for a specific organization with optional filters,
   * keyset pagination, and soft-delete exclusion.
   */
  async findMany(options: {
    orgId: string;
    verifierUserId?: string;
    afterId?: string | null;
    limit?: number;
    includeDeleted?: boolean;
  }): Promise<any[]> {
    const {
      orgId,
      verifierUserId,
      afterId,
      limit = 10,
      includeDeleted = false,
    } = options;

    const pageSize = normalizePageSize(limit);

    let query = this.db("milestones")
      .join("vaults", "milestones.vault_id", "vaults.id")
      .select(
        "milestones.id",
        "milestones.vault_id as vaultId",
        "milestones.title",
        "milestones.description",
        "milestones.target_amount as targetAmount",
        "milestones.current_amount as currentAmount",
        "milestones.deadline",
        "milestones.status",
        "milestones.verifier_user_id as verifierUserId",
        "milestones.created_at as createdAt",
        "milestones.updated_at as updatedAt",
        "milestones.deleted_at as deletedAt",
      )
      .where("vaults.organization_id", orgId)
      .orderBy("milestones.id", "asc")
      .limit(pageSize);

    if (!includeDeleted) {
      query = query.whereNull("milestones.deleted_at");
    }

    if (verifierUserId) {
      query = query.where("milestones.verifier_user_id", verifierUserId);
    }

    if (afterId) {
      query = query.where("milestones.id", ">", afterId);
    }

    return query;
  }

  /**
   * Find a milestone by ID, scoped to a specific organization.
   */
  async findByIdForOrg(
    id: string,
    orgId: string,
    includeDeleted = false,
  ): Promise<any | null> {
    let query = this.db("milestones")
      .join("vaults", "milestones.vault_id", "vaults.id")
      .select(
        "milestones.id",
        "milestones.vault_id as vaultId",
        "milestones.title",
        "milestones.description",
        "milestones.target_amount as targetAmount",
        "milestones.current_amount as currentAmount",
        "milestones.deadline",
        "milestones.status",
        "milestones.verifier_user_id as verifierUserId",
        "milestones.created_at as createdAt",
        "milestones.updated_at as updatedAt",
        "milestones.deleted_at as deletedAt",
      )
      .where("milestones.id", id)
      .where("vaults.organization_id", orgId);

    if (!includeDeleted) {
      query = query.whereNull("milestones.deleted_at");
    }

    const row = await query.first();
    return row || null;
  }
}

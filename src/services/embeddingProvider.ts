const EMBEDDING_DIMENSIONS = 768

export interface EmbeddingProvider {
  readonly modelVersion: string
  embed(text: string): Promise<number[]>
}

/**
 * Deterministic, network-free embedding provider used as the default so the
 * reindex job and its tests never depend on a real embedding API. Two calls
 * with the same text always produce the same vector, which is what makes the
 * backfill idempotent.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly modelVersion: string) {}

  async embed(text: string): Promise<number[]> {
    let seed = hashString(`${this.modelVersion}:${text}`)
    const vector: number[] = []
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff
      vector.push((seed & 0xffff) / 0xffff - 0.5)
    }
    const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0))
    return norm === 0 ? vector : vector.map((value) => value / norm)
  }
}

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

export const CURRENT_EMBEDDING_MODEL_VERSION = process.env.EMBEDDING_MODEL_VERSION ?? 'deterministic-v1'

export const createEmbeddingProvider = (
  modelVersion: string = CURRENT_EMBEDDING_MODEL_VERSION,
): EmbeddingProvider => new DeterministicEmbeddingProvider(modelVersion)

// ── Drift detection ───────────────────────────────────────────────────────────

export interface EmbeddingVersionCount {
  modelVersion: string
  count: number
  isCurrent: boolean
}

export interface EmbeddingDriftReport {
  currentModelVersion: string
  totalEmbeddings: number
  staleCount: number
  currentCount: number
  versions: EmbeddingVersionCount[]
}

/**
 * Query DB interface used by detectEmbeddingDrift — narrow so tests can
 * inject a simple fake without a real Knex instance.
 */
export interface EmbeddingDriftDb {
  (table: 'milestone_embeddings'): {
    select(col: string): { count(col: string): { as(alias: string): any }; groupBy(col: string): Promise<Array<{ model_version: string; count: string | number }>> }
    count(col: string): { as(alias: string): any }
    groupBy(col: string): Promise<Array<{ model_version: string; count: string | number }>>
  }
}

/**
 * Returns a drift report grouping stored embeddings by model_version vs the
 * active provider version. An embedding is "stale" when its model_version
 * differs from currentModelVersion.
 */
export async function detectEmbeddingDrift(
  db: { (table: string): any },
  currentModelVersion: string = CURRENT_EMBEDDING_MODEL_VERSION,
): Promise<EmbeddingDriftReport> {
  const rows: Array<{ model_version: string; count: string | number }> = await db('milestone_embeddings')
    .select('model_version')
    .count('milestone_id as count')
    .groupBy('model_version')

  const versions: EmbeddingVersionCount[] = rows.map((row) => ({
    modelVersion: row.model_version,
    count: Number(row.count),
    isCurrent: row.model_version === currentModelVersion,
  }))

  const totalEmbeddings = versions.reduce((s, v) => s + v.count, 0)
  const currentCount = versions.filter((v) => v.isCurrent).reduce((s, v) => s + v.count, 0)
  const staleCount = totalEmbeddings - currentCount

  return { currentModelVersion, totalEmbeddings, staleCount, currentCount, versions }
}

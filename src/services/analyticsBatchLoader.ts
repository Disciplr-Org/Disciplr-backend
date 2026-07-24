import { db as defaultDb } from '../db/database.js'

export interface VaultAggregate {
  vaultId: string
  status: string
  amount: string
  milestoneCount: number
  completedMilestones: number
}

export interface MilestoneAggregate {
  vaultId: string
  milestoneCount: number
  completedMilestones: number
  pendingMilestones: number
}

// Minimal subset of the better-sqlite3 Database interface used by the loader.
export interface DbLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
  }
}

/**
 * Request-scoped batch loader that coalesces per-vault and per-milestone reads
 * into single IN-clause queries, eliminating N+1 patterns in analytics aggregation.
 *
 * Lifecycle: create one instance per request/operation, call load* methods with
 * any number of keys, and results are fetched in a single batched query per key set.
 * The loader deduplicates keys and caches results within the same instance, so
 * repeated lookups within one request are free. Never reuse across requests to
 * prevent cross-tenant data leakage.
 *
 * @param db - Optional db override; defaults to the module-level singleton.
 *             Inject a test database to keep unit tests hermetic.
 */
export class AnalyticsBatchLoader {
  private readonly db: DbLike
  private vaultCache = new Map<string, VaultAggregate>()
  private milestoneCache = new Map<string, MilestoneAggregate>()
  private _queryCount = 0

  constructor(db: DbLike = defaultDb) {
    this.db = db
  }

  /** Number of DB queries issued (for test verification). */
  get queries(): number {
    return this._queryCount
  }

  /**
   * Load vault aggregates for a set of vault IDs in one query.
   * Deduplicates keys; already-cached keys do not trigger additional queries.
   */
  loadVaults(vaultIds: string[]): Map<string, VaultAggregate> {
    const unique = [...new Set(vaultIds)]
    const uncached = unique.filter((id) => !this.vaultCache.has(id))

    if (uncached.length > 0) {
      const placeholders = uncached.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT
            v.id          AS vaultId,
            v.status,
            v.amount,
            COUNT(m.id)   AS milestoneCount,
            SUM(CASE WHEN m.status = 'completed' THEN 1 ELSE 0 END) AS completedMilestones
          FROM vaults v
          LEFT JOIN milestones m ON m.vault_id = v.id
          WHERE v.id IN (${placeholders})
          GROUP BY v.id, v.status, v.amount`,
        )
        .all(...uncached) as {
          vaultId: string
          status: string
          amount: string
          milestoneCount: number
          completedMilestones: number
        }[]

      this._queryCount++

      for (const row of rows) {
        this.vaultCache.set(row.vaultId, {
          vaultId: row.vaultId,
          status: row.status,
          amount: row.amount,
          milestoneCount: Number(row.milestoneCount),
          completedMilestones: Number(row.completedMilestones),
        })
      }
    }

    const result = new Map<string, VaultAggregate>()
    for (const id of unique) {
      const hit = this.vaultCache.get(id)
      if (hit) result.set(id, hit)
    }
    return result
  }

  /**
   * Load milestone aggregates grouped by vault for a set of vault IDs in one query.
   */
  loadMilestones(vaultIds: string[]): Map<string, MilestoneAggregate> {
    const unique = [...new Set(vaultIds)]
    const uncached = unique.filter((id) => !this.milestoneCache.has(id))

    if (uncached.length > 0) {
      const placeholders = uncached.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT
            vault_id      AS vaultId,
            COUNT(*)      AS milestoneCount,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedMilestones,
            SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pendingMilestones
          FROM milestones
          WHERE vault_id IN (${placeholders})
          GROUP BY vault_id`,
        )
        .all(...uncached) as {
          vaultId: string
          milestoneCount: number
          completedMilestones: number
          pendingMilestones: number
        }[]

      this._queryCount++

      for (const row of rows) {
        this.milestoneCache.set(row.vaultId, {
          vaultId: row.vaultId,
          milestoneCount: Number(row.milestoneCount),
          completedMilestones: Number(row.completedMilestones),
          pendingMilestones: Number(row.pendingMilestones),
        })
      }

      // Vaults with no milestones won't appear in results — fill zeros so callers
      // get a defined value for every requested ID.
      for (const id of uncached) {
        if (!this.milestoneCache.has(id)) {
          this.milestoneCache.set(id, {
            vaultId: id,
            milestoneCount: 0,
            completedMilestones: 0,
            pendingMilestones: 0,
          })
        }
      }
    }

    const result = new Map<string, MilestoneAggregate>()
    for (const id of unique) {
      const hit = this.milestoneCache.get(id)
      if (hit) result.set(id, hit)
    }
    return result
  }
}

/** Factory: one loader per request scope. */
export function createAnalyticsBatchLoader(db?: DbLike): AnalyticsBatchLoader {
  return new AnalyticsBatchLoader(db)
}

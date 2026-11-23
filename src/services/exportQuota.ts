import type { Knex } from 'knex'
import { AsyncMutex } from '../utils/asyncMutex.js'

export interface OrgQuotaEntry {
  orgId: string
  quotaDate: string // YYYY-MM-DD UTC
  metric: string
  count: number
  limit: number
  updatedAt: string
}

interface OrgQuotaRecord {
  org_id: string
  quota_date: string
  metric: string
  count: number
  limit: number
  updated_at: string
}

export interface OrgQuotaRepository {
  /**
   * Atomically increment count for org/date/metric, but only when the current
   * count is below the limit. Returns the new entry when the increment was
   * applied, or `undefined` when the quota is already exhausted (no write is
   * performed). The stored counter therefore never exceeds the limit.
   */
  incrementIfWithinLimit(
    orgId: string,
    date: string,
    metric: string,
    dailyLimit: number,
  ): Promise<OrgQuotaEntry | undefined>
  get(orgId: string, date: string, metric: string): Promise<OrgQuotaEntry | undefined>
  reset(): Promise<void>
}

const utcDateString = (d = new Date()): string => d.toISOString().slice(0, 10)

export const createInMemoryOrgQuotaRepository = (): OrgQuotaRepository => {
  const store = new Map<string, OrgQuotaEntry>()
  const mutex = new AsyncMutex()
  const key = (orgId: string, date: string, metric: string) => `${orgId}:${date}:${metric}`

  return {
    // Read, check, and increment happen inside a single mutex critical section,
    // so concurrent callers can never observe a stale count or push the stored
    // counter past the limit. A request that would exceed the limit is refused
    // without writing anything.
    async incrementIfWithinLimit(orgId, date, metric, dailyLimit) {
      return mutex.runExclusive(() => {
        const k = key(orgId, date, metric)
        const existing = store.get(k)
        // A non-positive limit admits nothing, even for a brand-new bucket.
        if (dailyLimit <= 0) {
          return undefined
        }
        if (existing && existing.count >= existing.limit) {
          return undefined
        }
        const entry: OrgQuotaEntry = {
          orgId,
          quotaDate: date,
          metric,
          count: (existing?.count ?? 0) + 1,
          limit: dailyLimit,
          updatedAt: new Date().toISOString(),
        }
        store.set(k, entry)
        return { ...entry }
      })
    },
    async get(orgId, date, metric) {
      const entry = store.get(key(orgId, date, metric))
      return entry ? { ...entry } : undefined
    },
    async reset() {
      store.clear()
    },
  }
}

export const createKnexOrgQuotaRepository = (db: Knex): OrgQuotaRepository => ({
  async incrementIfWithinLimit(orgId, date, metric, dailyLimit) {
    const now = new Date().toISOString()
    // Atomic conditional upsert: the counter is incremented only while it is
    // below the limit, and the resulting row is returned in the same statement.
    // When the quota is exhausted the UPDATE clause matches no row, nothing is
    // written, and no row is returned.
    const result = await db.raw(
      `INSERT INTO org_quotas (org_id, quota_date, metric, count, "limit", updated_at)
       SELECT :orgId, :date, :metric, 1, :limit, :now
       WHERE :limit > 0
       ON CONFLICT (org_id, quota_date, metric)
       DO UPDATE SET count = org_quotas.count + 1, updated_at = :now
       WHERE org_quotas.count < org_quotas."limit"
       RETURNING org_id, quota_date, metric, count, "limit", updated_at`,
      { orgId, date, metric, limit: dailyLimit, now },
    )

    const row = result?.rows?.[0]
    if (!row) {
      return undefined
    }

    return {
      orgId: row.org_id,
      quotaDate: row.quota_date,
      metric: row.metric,
      count: row.count,
      limit: row.limit,
      updatedAt: row.updated_at,
    }
  },
  async get(orgId, date, metric) {
    const row = await db<OrgQuotaRecord>('org_quotas')
      .where({ org_id: orgId, quota_date: date, metric })
      .first()
    if (!row) return undefined
    return {
      orgId: row.org_id,
      quotaDate: row.quota_date,
      metric: row.metric,
      count: row.count,
      limit: row.limit,
      updatedAt: row.updated_at,
    }
  },
  async reset() {
    await db('org_quotas').delete()
  },
})

let orgQuotaRepository: OrgQuotaRepository = createInMemoryOrgQuotaRepository()

export const configureOrgQuotaRepository = (repo: OrgQuotaRepository): void => {
  orgQuotaRepository = repo
}

export const EXPORT_QUOTA_METRIC = 'exports'

/**
 * Check and increment the org export quota for today.
 * Returns { allowed: true } when under limit, or { allowed: false, retryAfter } when exceeded.
 * The check and the increment are one atomic repository operation, so concurrent
 * requests observe a consistent counter and exactly `dailyLimit` requests are
 * ever admitted per org/date/metric — never more, regardless of burst size.
 */
export const checkAndIncrementExportQuota = async (
  orgId: string,
  dailyLimit: number,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> => {
  const today = utcDateString()

  const entry = await orgQuotaRepository.incrementIfWithinLimit(
    orgId,
    today,
    EXPORT_QUOTA_METRIC,
    dailyLimit,
  )
  if (!entry) {
    // Quota already exhausted — nothing was written.
    return { allowed: false, retryAfter: secondsUntilEndOfUtcDay() }
  }

  return { allowed: true }
}

/** Seconds remaining until midnight UTC */
const secondsUntilEndOfUtcDay = (): number => {
  const now = new Date()
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000))
}

export const resetOrgQuotas = (): Promise<void> => orgQuotaRepository.reset()

export { utcDateString }

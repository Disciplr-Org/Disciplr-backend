import type { Knex } from 'knex'

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

interface OrgQuotaRepository {
  /** Atomically increment count for org/date/metric. Returns the new entry.
   *  Creates the row with count=1 if it does not exist yet. */
  increment(orgId: string, date: string, metric: string, dailyLimit: number): Promise<OrgQuotaEntry>
  get(orgId: string, date: string, metric: string): Promise<OrgQuotaEntry | undefined>
  reset(): Promise<void>
}

const utcDateString = (d = new Date()): string => d.toISOString().slice(0, 10)

/**
 * Simple async mutex for coordinating in-memory quota increments.
 * Prevents race conditions where concurrent reads can bypass the quota limit.
 */
class AsyncMutex {
  private locked = false
  private waitQueue: (() => void)[] = []

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // Acquire lock
    while (this.locked) {
      await new Promise((resolve) => this.waitQueue.push(resolve))
    }
    this.locked = true

    try {
      return await Promise.resolve(fn())
    } finally {
      // Release lock and wake next waiter
      this.locked = false
      const next = this.waitQueue.shift()
      if (next) next()
    }
  }
}

const createInMemoryOrgQuotaRepository = (): OrgQuotaRepository => {
  const store = new Map<string, OrgQuotaEntry>()
  const mutex = new AsyncMutex()
  const key = (orgId: string, date: string, metric: string) => `${orgId}:${date}:${metric}`

  return {
    async increment(orgId, date, metric, dailyLimit) {
      // Atomically read, check, and increment under mutex
      return mutex.runExclusive(() => {
        const k = key(orgId, date, metric)
        const existing = store.get(k)
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
  async increment(orgId, date, metric, dailyLimit) {
    const now = new Date().toISOString()
    // Upsert: increment count atomically
    await db.raw(
      `INSERT INTO org_quotas (org_id, quota_date, metric, count, "limit", updated_at)
       VALUES (:orgId, :date, :metric, 1, :limit, :now)
       ON CONFLICT (org_id, quota_date, metric)
       DO UPDATE SET count = org_quotas.count + 1, updated_at = :now`,
      { orgId, date, metric, limit: dailyLimit, now },
    )
    const row = await db<OrgQuotaRecord>('org_quotas')
      .where({ org_id: orgId, quota_date: date, metric })
      .first()

    return {
      orgId: row!.org_id,
      quotaDate: row!.quota_date,
      metric: row!.metric,
      count: row!.count,
      limit: row!.limit,
      updatedAt: row!.updated_at,
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
 * The counter is only incremented when the current count is below the limit.
 */
export const checkAndIncrementExportQuota = async (
  orgId: string,
  dailyLimit: number,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> => {
  const today = utcDateString()

  // Read first to avoid incrementing over-quota requests
  const existing = await orgQuotaRepository.get(orgId, today, EXPORT_QUOTA_METRIC)
  if (existing && existing.count >= existing.limit) {
    return { allowed: false, retryAfter: secondsUntilEndOfUtcDay() }
  }

  const entry = await orgQuotaRepository.increment(orgId, today, EXPORT_QUOTA_METRIC, dailyLimit)
  if (entry.count > entry.limit) {
    // Raced past the limit (concurrent requests); still reject
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

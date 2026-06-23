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

type OrgQuotaIncrementResult = OrgQuotaEntry & { granted?: boolean }

interface OrgQuotaRepository {
  /**
   * Atomically grants one quota unit when count is still below dailyLimit.
   * Implementations must leave count unchanged and return granted=false once exhausted.
   */
  increment(orgId: string, date: string, metric: string, dailyLimit: number): Promise<OrgQuotaIncrementResult>
  get(orgId: string, date: string, metric: string): Promise<OrgQuotaEntry | undefined>
  reset(): Promise<void>
}

const utcDateString = (d = new Date()): string => d.toISOString().slice(0, 10)

const createInMemoryOrgQuotaRepository = (): OrgQuotaRepository => {
  const store = new Map<string, OrgQuotaEntry>()
  const key = (orgId: string, date: string, metric: string) => `${orgId}:${date}:${metric}`

  return {
    async increment(orgId, date, metric, dailyLimit) {
      const k = key(orgId, date, metric)
      const existing = store.get(k)
      const count = existing?.count ?? 0
      const granted = count < dailyLimit
      const entry: OrgQuotaEntry = {
        orgId,
        quotaDate: date,
        metric,
        count: granted ? count + 1 : count,
        limit: dailyLimit,
        updatedAt: granted || !existing ? new Date().toISOString() : existing.updatedAt,
      }
      store.set(k, entry)
      return { ...entry, granted }
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

const firstRawRow = <T>(result: unknown): T | undefined => {
  if (result && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows?: T[] }).rows ?? [])[0]
  }

  if (Array.isArray(result)) {
    const [first] = result as unknown[]
    if (Array.isArray(first)) return first[0] as T | undefined
    return first as T | undefined
  }

  return undefined
}

const toQuotaEntry = (row: OrgQuotaRecord): OrgQuotaEntry => ({
  orgId: row.org_id,
  quotaDate: row.quota_date,
  metric: row.metric,
  count: row.count,
  limit: row.limit,
  updatedAt: row.updated_at,
})

const emptyQuotaEntry = (orgId: string, date: string, metric: string, dailyLimit: number): OrgQuotaEntry => ({
  orgId,
  quotaDate: date,
  metric,
  count: 0,
  limit: dailyLimit,
  updatedAt: new Date().toISOString(),
})

export const createKnexOrgQuotaRepository = (db: Knex): OrgQuotaRepository => ({
  async increment(orgId, date, metric, dailyLimit) {
    if (dailyLimit <= 0) {
      const row = await db<OrgQuotaRecord>('org_quotas')
        .where({ org_id: orgId, quota_date: date, metric })
        .first()
      return { ...(row ? toQuotaEntry(row) : emptyQuotaEntry(orgId, date, metric, dailyLimit)), granted: false }
    }

    const now = new Date().toISOString()
    const result = await db.raw(
      `INSERT INTO org_quotas (org_id, quota_date, metric, count, "limit", updated_at)
       VALUES (:orgId, :date, :metric, 1, :limit, :now)
       ON CONFLICT (org_id, quota_date, metric)
       DO UPDATE SET count = org_quotas.count + 1, "limit" = :limit, updated_at = :now
       WHERE org_quotas.count < :limit
       RETURNING org_id, quota_date, metric, count, "limit", updated_at`,
      { orgId, date, metric, limit: dailyLimit, now },
    )
    const grantedRow = firstRawRow<OrgQuotaRecord>(result)
    if (grantedRow) return { ...toQuotaEntry(grantedRow), granted: true }

    const row = await db<OrgQuotaRecord>('org_quotas')
      .where({ org_id: orgId, quota_date: date, metric })
      .first()

    return { ...(row ? toQuotaEntry(row) : emptyQuotaEntry(orgId, date, metric, dailyLimit)), granted: false }
  },
  async get(orgId, date, metric) {
    const row = await db<OrgQuotaRecord>('org_quotas')
      .where({ org_id: orgId, quota_date: date, metric })
      .first()
    if (!row) return undefined
    return toQuotaEntry(row)
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
  if (dailyLimit <= 0) {
    return { allowed: false, retryAfter: secondsUntilEndOfUtcDay() }
  }

  const today = utcDateString()
  const entry = await orgQuotaRepository.increment(orgId, today, EXPORT_QUOTA_METRIC, dailyLimit)
  if (entry.granted === false || entry.count > entry.limit) {
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

export const getOrgQuotaEntry = (
  orgId: string,
  date = utcDateString(),
  metric = EXPORT_QUOTA_METRIC,
): Promise<OrgQuotaEntry | undefined> => orgQuotaRepository.get(orgId, date, metric)

export { utcDateString }

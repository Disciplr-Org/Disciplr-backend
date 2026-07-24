/**
 * In-memory store for per-org analytics report records.
 *
 * Each report entry holds a reference to the S3 key (or a local JSON buffer
 * when S3 is not configured) for the rendered snapshot.  Signed download URLs
 * are generated on demand from the stored S3 key.
 *
 * Retention: reports older than ANALYTICS_REPORT_RETENTION_DAYS are pruned
 * automatically whenever a new report is saved for that org.
 */

const DEFAULT_RETENTION_DAYS =
  Number.parseInt(process.env.ANALYTICS_REPORT_RETENTION_DAYS ?? '30', 10) || 30

const DEFAULT_REPORT_QUOTA =
  Number.parseInt(process.env.ANALYTICS_REPORT_DAILY_QUOTA ?? '10', 10) || 10

export interface AnalyticsReport {
  id: string
  orgId: string
  createdAt: string
  /** Present when S3 is configured. */
  s3Key?: string
  /** Present when S3 is not configured (dev / test). */
  localBuffer?: Buffer
  snapshotAt: string
  /** Content size in bytes (for informational purposes). */
  sizeBytes: number
}

// Keyed by orgId -> AnalyticsReport[]  (sorted oldest-first)
const _store = new Map<string, AnalyticsReport[]>()

export function _resetReportsStore(): void {
  _store.clear()
}

/** Return a shallow copy of all reports for an org, newest-first. */
export function getOrgReports(orgId: string): AnalyticsReport[] {
  return (_store.get(orgId) ?? []).slice().reverse()
}

/**
 * Persist a new report record for an org and purge stale entries.
 * Returns the saved report.
 */
export function saveOrgReport(
  report: Omit<AnalyticsReport, 'id' | 'createdAt'>,
  retentionDays = DEFAULT_RETENTION_DAYS,
): AnalyticsReport {
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
  const saved: AnalyticsReport = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...report,
  }

  const list = _store.get(report.orgId) ?? []
  list.push(saved)
  _store.set(report.orgId, list)

  purgeOldReports(report.orgId, retentionDays)
  return saved
}

/** Remove reports older than `retentionDays` for the given org. */
function purgeOldReports(orgId: string, retentionDays: number): void {
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
  const cutoffIso = cutoff.toISOString()

  const list = _store.get(orgId)
  if (!list) return

  const kept = list.filter((r) => r.createdAt >= cutoffIso)
  if (kept.length !== list.length) {
    _store.set(orgId, kept)
  }
}

/** All org IDs that currently have at least one stored report. */
export function getAllOrgIds(): string[] {
  return Array.from(_store.keys())
}

/** Daily in-memory quota counters (orgId -> date -> count). */
const _quotaCounters = new Map<string, Map<string, number>>()

export function _resetQuotaCounters(): void {
  _quotaCounters.clear()
}

const utcDate = (d = new Date()): string => d.toISOString().slice(0, 10)

/**
 * Check and increment the per-org report-generation quota for today.
 * Returns true when allowed, false when the daily cap is exhausted.
 */
export function checkAndIncrementReportQuota(
  orgId: string,
  dailyLimit = DEFAULT_REPORT_QUOTA,
): boolean {
  const today = utcDate()
  if (!_quotaCounters.has(orgId)) {
    _quotaCounters.set(orgId, new Map())
  }
  const byDate = _quotaCounters.get(orgId)!
  const current = byDate.get(today) ?? 0
  if (current >= dailyLimit) return false
  byDate.set(today, current + 1)
  return true
}

/**
 * Store for per-org analytics report records.
 *
 * Each report entry holds a reference to the S3 key (or a local JSON buffer
 * when S3 is not configured) for the rendered snapshot. Signed download URLs
 * are generated on demand from the stored S3 key.
 *
 * Retention: reports older than ANALYTICS_REPORT_RETENTION_DAYS are pruned
 * automatically whenever a new report is saved for that org.
 */

import { prisma } from '../lib/prisma.js'

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

export async function _resetReportsStore(): Promise<void> {
  await prisma.analyticsReport.deleteMany()
}

/** Return a shallow copy of all reports for an org, newest-first. */
export async function getOrgReports(orgId: string): Promise<AnalyticsReport[]> {
  const reports = await prisma.analyticsReport.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
  })
  return reports.map((r: any) => ({
    id: r.id,
    orgId: r.orgId,
    createdAt: r.createdAt.toISOString(),
    s3Key: r.s3Key ?? undefined,
    localBuffer: r.localBuffer ?? undefined,
    snapshotAt: r.snapshotAt.toISOString(),
    sizeBytes: r.sizeBytes,
  }))
}

/**
 * Persist a new report record for an org and purge stale entries.
 * Returns the saved report.
 */
export async function saveOrgReport(
  report: Omit<AnalyticsReport, 'id' | 'createdAt'>,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Promise<AnalyticsReport> {
  const saved = await prisma.analyticsReport.create({
    data: {
      orgId: report.orgId,
      s3Key: report.s3Key,
      localBuffer: report.localBuffer ?? null,
      snapshotAt: new Date(report.snapshotAt),
      sizeBytes: report.sizeBytes,
    },
  })

  await purgeOldReports(report.orgId, retentionDays)
  
  return {
    id: saved.id,
    orgId: saved.orgId,
    createdAt: saved.createdAt.toISOString(),
    s3Key: saved.s3Key ?? undefined,
    localBuffer: saved.localBuffer ?? undefined,
    snapshotAt: saved.snapshotAt.toISOString(),
    sizeBytes: saved.sizeBytes,
  }
}

/** Remove reports older than `retentionDays` for the given org. */
async function purgeOldReports(orgId: string, retentionDays: number): Promise<void> {
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)

  await prisma.analyticsReport.deleteMany({
    where: {
      orgId,
      createdAt: { lt: cutoff },
    },
  })
}

/** All org IDs that currently have at least one stored report. */
export async function getAllOrgIds(): Promise<string[]> {
  const reports = await prisma.analyticsReport.findMany({
    select: { orgId: true },
    distinct: ['orgId'],
  })
  return reports.map((r: any) => r.orgId)
}

export async function _resetQuotaCounters(): Promise<void> {
  await prisma.analyticsReportQuota.deleteMany()
}

const utcDate = (d = new Date()): Date => {
  const iso = d.toISOString().slice(0, 10)
  return new Date(iso)
}

/**
 * Check and increment the per-org report-generation quota for today.
 * Returns true when allowed, false when the daily cap is exhausted.
 */
export async function checkAndIncrementReportQuota(
  orgId: string,
  dailyLimit = DEFAULT_REPORT_QUOTA,
): Promise<boolean> {
  const today = utcDate()
  
  const quota = await prisma.analyticsReportQuota.upsert({
    where: {
      orgId_date: {
        orgId,
        date: today,
      },
    },
    update: {},
    create: {
      orgId,
      date: today,
      count: 0,
    },
  })

  if (quota.count >= dailyLimit) {
    return false
  }

  await prisma.analyticsReportQuota.update({
    where: { id: quota.id },
    data: { count: { increment: 1 } },
  })

  return true
}

import { db, getTimeRangeFilter, updateAnalyticsSummary } from '../db/database.js'
import type { VaultAnalytics, VaultAnalyticsWithPeriod } from '../types/vault.js'
import { utcNow } from '../utils/timestamps.js'
import { createAnalyticsBatchLoader, type DbLike } from './analyticsBatchLoader.js'

export interface OrgVaultAnalytics {
  totalVaults: number
  activeVaults: number
  completedVaults: number
  failedVaults: number
  totalLockedCapital: string
  successRate: number
  totalMilestones: number
  completedMilestones: number
}

/**
 * Compute analytics for a set of vault IDs belonging to a single org/tenant using
 * a request-scoped batch loader. All vault and milestone reads are coalesced into
 * at most two queries (one per entity type) regardless of how many vault IDs are
 * supplied, eliminating the N+1 pattern.
 *
 * @param vaultIds - IDs of vaults owned by the org. Must all belong to the same
 *                   tenant; never mix IDs across orgs to preserve isolation.
 * @param dbOverride - Optional DB instance; defaults to the module-level singleton.
 *                     Inject a test database to keep unit tests hermetic.
 */
export function getOrgAnalyticsBatched(vaultIds: string[], dbOverride?: DbLike): OrgVaultAnalytics {
  if (vaultIds.length === 0) {
    return {
      totalVaults: 0,
      activeVaults: 0,
      completedVaults: 0,
      failedVaults: 0,
      totalLockedCapital: '0',
      successRate: 0,
      totalMilestones: 0,
      completedMilestones: 0,
    }
  }

  const loader = createAnalyticsBatchLoader(dbOverride)
  const vaultMap = loader.loadVaults(vaultIds)
  const milestoneMap = loader.loadMilestones(vaultIds)

  let activeVaults = 0
  let completedVaults = 0
  let failedVaults = 0
  let totalCapital = 0

  for (const agg of vaultMap.values()) {
    if (agg.status === 'active') activeVaults++
    else if (agg.status === 'completed') completedVaults++
    else if (agg.status === 'failed') failedVaults++
    totalCapital += parseFloat(agg.amount ?? '0')
  }

  let totalMilestones = 0
  let completedMilestones = 0
  for (const agg of milestoneMap.values()) {
    totalMilestones += agg.milestoneCount
    completedMilestones += agg.completedMilestones
  }

  const resolved = completedVaults + failedVaults
  const successRate = resolved > 0 ? completedVaults / resolved : 0

  return {
    totalVaults: vaultMap.size,
    activeVaults,
    completedVaults,
    failedVaults,
    totalLockedCapital: totalCapital.toString(),
    successRate,
    totalMilestones,
    completedMilestones,
  }
}

/**
 * Get overall vault analytics summary (all-time)
 */
export function getOverallAnalytics(): VaultAnalytics {
    const summary = db.prepare(`
    SELECT 
      total_vaults,
      active_vaults,
      completed_vaults,
      failed_vaults,
      total_locked_capital,
      active_capital,
      success_rate,
      last_updated
    FROM vault_analytics_summary
    WHERE id = 1
  `).get() as {
        total_vaults: number
        active_vaults: number
        completed_vaults: number
        failed_vaults: number
        total_locked_capital: string
        active_capital: string
        success_rate: number
        last_updated: string
    }

    return {
        totalVaults: summary.total_vaults,
        activeVaults: summary.active_vaults,
        completedVaults: summary.completed_vaults,
        failedVaults: summary.failed_vaults,
        totalLockedCapital: summary.total_locked_capital,
        activeCapital: summary.active_capital,
        successRate: summary.success_rate,
        lastUpdated: summary.last_updated,
    }
}

/**
 * Get vault analytics for a specific time period
 */
export function getAnalyticsByPeriod(period: string): VaultAnalyticsWithPeriod {
    const { startDate, endDate } = getTimeRangeFilter(period)
    
    console.log(`[${utcNow()}] [Analytics] Fetching stats for period: ${period} [Range: ${startDate} - ${endDate}]`)

    const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_vaults,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_vaults,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_vaults,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_vaults,
      SUM(CAST(amount AS REAL)) as total_locked_capital,
      SUM(CASE WHEN status = 'active' THEN CAST(amount AS REAL) ELSE 0 END) as active_capital
    FROM vaults
    WHERE created_at >= ? AND created_at <= ?
  `).get(startDate, endDate) as {
        total_vaults: number
        active_vaults: number
        completed_vaults: number
        failed_vaults: number
        total_locked_capital: number | null
        active_capital: number | null
    }

    const totalCompleted = stats.completed_vaults || 0
    const totalFailed = stats.failed_vaults || 0
    const successRate = (totalCompleted + totalFailed) > 0
        ? (totalCompleted / (totalCompleted + totalFailed)) * 100
        : 0

    return {
        totalVaults: stats.total_vaults || 0,
        activeVaults: stats.active_vaults || 0,
        completedVaults: stats.completed_vaults || 0,
        failedVaults: stats.failed_vaults || 0,
        totalLockedCapital: (stats.total_locked_capital || 0).toString(),
        activeCapital: (stats.active_capital || 0).toString(),
        successRate: Math.round(successRate * 100) / 100,
        lastUpdated: new Date().toISOString(),
        period,
        startDate,
        endDate,
    }
}

/**
 * Get vault status breakdown for dashboard
 */
export function getVaultStatusBreakdown(): {
    byStatus: Record<string, number>
    byStatusAndPeriod: Record<string, Record<string, number>>
} {
    const allTime = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM vaults
    GROUP BY status
  `).all() as { status: string; count: number }[]

    const byStatus: Record<string, number> = {}
    allTime.forEach((row) => {
        byStatus[row.status] = row.count
    })

    // Get breakdown for last 30 days
    const { startDate, endDate } = getTimeRangeFilter('30d')
    const last30Days = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM vaults
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY status
  `).all(startDate, endDate) as { status: string; count: number }[]

    const byStatusAndPeriod: Record<string, Record<string, number>> = {
        '30d': {},
    }
    last30Days.forEach((row) => {
        byStatusAndPeriod['30d'][row.status] = row.count
    })

    return { byStatus, byStatusAndPeriod }
}

/**
 * Get capital analytics
 */
export function getCapitalAnalytics(period: string = 'all'): {
    totalLockedCapital: string
    activeCapital: string
    averageVaultSize: string
    period: string
} {
    let stats: {
        total_locked_capital: number | null
        active_capital: number | null
        avg_size: number | null
        vault_count: number
    }

    if (period === 'all') {
        stats = db.prepare(`
      SELECT 
        SUM(CAST(amount AS REAL)) as total_locked_capital,
        SUM(CASE WHEN status = 'active' THEN CAST(amount AS REAL) ELSE 0 END) as active_capital,
        AVG(CAST(amount AS REAL)) as avg_size,
        COUNT(*) as vault_count
      FROM vaults
    `).get() as typeof stats
    } else {
        const { startDate, endDate } = getTimeRangeFilter(period)
        console.log(`[${utcNow()}] [Analytics] Fetching capital stats for period: ${period} [Range: ${startDate} - ${endDate}]`)
        stats = db.prepare(`
      SELECT 
        SUM(CAST(amount AS REAL)) as total_locked_capital,
        SUM(CASE WHEN status = 'active' THEN CAST(amount AS REAL) ELSE 0 END) as active_capital,
        AVG(CAST(amount AS REAL)) as avg_size,
        COUNT(*) as vault_count
      FROM vaults
      WHERE created_at >= ? AND created_at <= ?
    `).get(startDate, endDate) as typeof stats
    }

    return {
        totalLockedCapital: (stats.total_locked_capital || 0).toString(),
        activeCapital: (stats.active_capital || 0).toString(),
        averageVaultSize: stats.vault_count > 0 ? (stats.avg_size || 0).toFixed(2) : '0',
        period,
    }
}

export { updateAnalyticsSummary }

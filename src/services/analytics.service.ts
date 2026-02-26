import { db, getTimeRangeFilter, updateAnalyticsSummary } from '../db/database.js'
import type { VaultAnalytics, VaultAnalyticsWithPeriod } from '../types/vault.js'

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

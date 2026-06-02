import { 
  queryVaultStatsByPeriod,
  queryVaultStatusBreakdownAllTime,
  queryVaultStatusBreakdownByPeriod,
  readAnalyticsSummary,
  updateAnalyticsSummary as dbUpdateSummary,
  getTimeRangeFilter
} from '../db/database.js'
import type { VaultAnalytics, VaultAnalyticsWithPeriod } from '../types/vault.js'
import { utcNow } from '../utils/timestamps.js'

export async function getOverallAnalytics(): Promise<VaultAnalytics> {
  const summary = await readAnalyticsSummary()
  
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

export async function getAnalyticsByPeriod(period: string): Promise<VaultAnalyticsWithPeriod> {
  const { startDate, endDate } = getTimeRangeFilter(period)
  
  const stats = await queryVaultStatsByPeriod(startDate, endDate)
  
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

export async function getVaultStatusBreakdown(): Promise<{
  byStatus: Record<string, number>
  byStatusAndPeriod: Record<string, Record<string, number>>
}> {
  const allTimeRows = await queryVaultStatusBreakdownAllTime()
  
  const byStatus: Record<string, number> = {}
  allTimeRows.forEach((row) => {
    byStatus[row.status] = row.count
  })

  const { startDate, endDate } = getTimeRangeFilter('30d')
  const last30DaysRows = await queryVaultStatusBreakdownByPeriod(startDate, endDate)

  const byStatusAndPeriod: Record<string, Record<string, number>> = {
    '30d': {},
  }
  last30DaysRows.forEach((row) => {
    byStatusAndPeriod['30d'][row.status] = row.count
  })

  return { byStatus, byStatusAndPeriod }
}

export async function getCapitalAnalytics(period: string = 'all'): Promise<{
  totalLockedCapital: string
  activeCapital: string
  averageVaultSize: string
  period: string
}> {
  let totalLockedCapital = 0
  let activeCapital = 0
  let totalVaults = 0

  if (period === 'all') {
    const stats = await queryVaultStatsByPeriod(
      new Date(0).toISOString(),
      new Date().toISOString()
    )
    totalLockedCapital = stats.total_locked_capital || 0
    activeCapital = stats.active_capital || 0
    totalVaults = stats.total_vaults || 0
  } else {
    const { startDate, endDate } = getTimeRangeFilter(period)
    const stats = await queryVaultStatsByPeriod(startDate, endDate)
    totalLockedCapital = stats.total_locked_capital || 0
    activeCapital = stats.active_capital || 0
    totalVaults = stats.total_vaults || 0
  }

  const avgSize = totalVaults > 0 ? totalLockedCapital / totalVaults : 0

  return {
    totalLockedCapital: totalLockedCapital.toString(),
    activeCapital: activeCapital.toString(),
    averageVaultSize: avgSize.toFixed(2),
    period,
  }
}

export { dbUpdateSummary as updateAnalyticsSummary }
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
import { getOrSet, invalidate } from '../lib/cache.js'

export async function getOverallAnalytics(orgId?: string): Promise<VaultAnalytics> {
  return getOrSet('analytics:overall', 300, async () => {
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
  }, orgId)
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

export async function updateAnalyticsSummary(orgId?: string): Promise<void> {
  await dbUpdateSummary()
  await invalidate('analytics:overall', orgId)
}
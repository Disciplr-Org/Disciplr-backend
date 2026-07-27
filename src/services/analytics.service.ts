import {
  queryVaultStatsByPeriod,
  queryVaultStatusBreakdownAllTime,
  queryVaultStatusBreakdownByPeriod,
  readAnalyticsSummary,
  updateAnalyticsSummary as dbUpdateSummary,
  getTimeRangeFilter
} from '../db/database.js'
import type { VaultAnalytics, VaultAnalyticsWithPeriod } from '../types/vault.js'
import { parseAndNormalizeToUTC, utcNow } from '../utils/timestamps.js'
import { getOrSet, invalidate } from '../lib/cache.js'
import { getOrgAnalyticsBatched } from './analyticsBatchLoader.js'
import type { OrgVaultAnalytics } from './analyticsBatchLoader.js'

export interface OrgRiskAnalyticsVault {
  id?: string
  orgId?: string
  amount?: string | number | null
  status?: string | null
  createdAt?: string | null
  startTimestamp?: string | null
  endTimestamp?: string | null
  stakedAmount?: string | number | null
  netStakedAmount?: string | number | null
  resolution?: string | null
  finalStatus?: string | null
  outcome?: string | null
  result?: string | null
  terminationReason?: string | null
  statusReason?: string | null
  [key: string]: unknown
}

export interface OrgRiskAnalyticsResponse {
  orgId: string
  generatedAt: string
  range: {
    startDate: string
    endDate: string
  }
  analytics: {
    totalVaults: number
    activeVaults: number
    resolvedVaults: number
    slashedVaults: number
    slashRate: number
    capitalAtRisk: string
  }
}

function normalizeOrgRiskRange(startDate?: string, endDate?: string): { startDate: string; endDate: string } {
  const normalizedStart = startDate ? parseAndNormalizeToUTC(startDate) : new Date(0).toISOString()
  const normalizedEnd = endDate ? parseAndNormalizeToUTC(endDate) : utcNow()

  if (new Date(normalizedStart).getTime() > new Date(normalizedEnd).getTime()) {
    throw new Error('startDate must be before or equal to endDate')
  }

  return { startDate: normalizedStart, endDate: normalizedEnd }
}

function readNumericAmount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function getVaultAmount(vault: OrgRiskAnalyticsVault): number {
  const candidates = [
    vault.stakedAmount,
    vault.netStakedAmount,
    vault.amount,
  ]

  for (const candidate of candidates) {
    const value = readNumericAmount(candidate)
    if (value > 0) return value
  }

  return 0
}

function isInRange(vault: OrgRiskAnalyticsVault, startDate: string, endDate: string): boolean {
  const anchor = vault.createdAt ?? vault.startTimestamp ?? vault.endTimestamp
  if (!anchor) return true

  const normalizedAnchor = parseAndNormalizeToUTC(anchor)
  return normalizedAnchor >= startDate && normalizedAnchor <= endDate
}

function isSlashOutcome(vault: OrgRiskAnalyticsVault): boolean {
  const candidates = [
    vault.resolution,
    vault.finalStatus,
    vault.outcome,
    vault.result,
    vault.terminationReason,
    vault.statusReason,
  ]

  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').trim().toLowerCase()
    if (normalized === 'slash_on_miss' || normalized === 'slashed' || normalized === 'slash') {
      return true
    }
  }

  return vault.status === 'failed'
}

export function getOrgRiskAnalytics(
  orgId: string,
  vaults: OrgRiskAnalyticsVault[],
  options: { startDate?: string; endDate?: string } = {},
): OrgRiskAnalyticsResponse {
  const { startDate, endDate } = normalizeOrgRiskRange(options.startDate, options.endDate)
  const scopedVaults = vaults.filter((vault) => vault.orgId === orgId && isInRange(vault, startDate, endDate))

  const activeVaults = scopedVaults.filter((vault) => vault.status === 'active')
  const resolvedVaults = scopedVaults.filter((vault) => vault.status === 'completed' || vault.status === 'failed')
  const slashedVaults = resolvedVaults.filter((vault) => isSlashOutcome(vault))
  const capitalAtRisk = activeVaults.reduce((sum, vault) => sum + getVaultAmount(vault), 0)
  const slashRate = resolvedVaults.length > 0 ? slashedVaults.length / resolvedVaults.length : 0

  return {
    orgId,
    generatedAt: utcNow(),
    range: { startDate, endDate },
    analytics: {
      totalVaults: scopedVaults.length,
      activeVaults: activeVaults.length,
      resolvedVaults: resolvedVaults.length,
      slashedVaults: slashedVaults.length,
      slashRate,
      capitalAtRisk: capitalAtRisk.toString(),
    },
  }
}

export async function getOverallAnalytics(): Promise<VaultAnalytics> {
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

export async function getAnalyticsByPeriod(
  period: string,
): Promise<VaultAnalyticsWithPeriod> {
  const { startDate, endDate } = getTimeRangeFilter(period);

  const stats = await queryVaultStatsByPeriod(startDate, endDate);

  const totalCompleted = stats.completed_vaults || 0;
  const totalFailed = stats.failed_vaults || 0;
  const successRate =
    totalCompleted + totalFailed > 0
      ? (totalCompleted / (totalCompleted + totalFailed)) * 100
      : 0;

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
  };
}

export async function getVaultStatusBreakdown(): Promise<{
  byStatus: Record<string, number>;
  byStatusAndPeriod: Record<string, Record<string, number>>;
}> {
  const allTimeRows = await queryVaultStatusBreakdownAllTime();

  const byStatus: Record<string, number> = {};
  allTimeRows.forEach((row) => {
    byStatus[row.status] = row.count;
  });

  const { startDate, endDate } = getTimeRangeFilter("30d");
  const last30DaysRows = await queryVaultStatusBreakdownByPeriod(
    startDate,
    endDate,
  );

  const byStatusAndPeriod: Record<string, Record<string, number>> = {
    "30d": {},
  };
  last30DaysRows.forEach((row) => {
    byStatusAndPeriod["30d"][row.status] = row.count;
  });

  return { byStatus, byStatusAndPeriod };
}

export async function getCapitalAnalytics(period: string = "all"): Promise<{
  totalLockedCapital: string;
  activeCapital: string;
  averageVaultSize: string;
  period: string;
}> {
  let totalLockedCapital = 0;
  let activeCapital = 0;
  let totalVaults = 0;

  if (period === "all") {
    const stats = await queryVaultStatsByPeriod(
      new Date(0).toISOString(),
      new Date().toISOString(),
    );
    totalLockedCapital = stats.total_locked_capital || 0;
    activeCapital = stats.active_capital || 0;
    totalVaults = stats.total_vaults || 0;
  } else {
    const { startDate, endDate } = getTimeRangeFilter(period);
    const stats = await queryVaultStatsByPeriod(startDate, endDate);
    totalLockedCapital = stats.total_locked_capital || 0;
    activeCapital = stats.active_capital || 0;
    totalVaults = stats.total_vaults || 0;
  }

  const avgSize = totalVaults > 0 ? totalLockedCapital / totalVaults : 0;

  return {
    totalLockedCapital: totalLockedCapital.toString(),
    activeCapital: activeCapital.toString(),
    averageVaultSize: avgSize.toFixed(2),
    period,
  };
}

export async function updateAnalyticsSummary(orgId?: string): Promise<void> {
  await dbUpdateSummary()
  await invalidate('analytics:overall', orgId)
}

/**
 * Render a point-in-time analytics snapshot for a single org.
 * Pulls vault IDs from the in-memory vaults store so it works without a DB.
 */
export async function renderOrgAnalyticsSnapshot(orgId: string): Promise<OrgVaultAnalytics & { orgId: string; snapshotAt: string }> {
  // Import lazily to avoid circular deps and to stay hermetic in tests
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { vaults } = require('../routes/vaults.js') as { vaults: Array<{ id: string; orgId?: string }> }
  const orgVaultIds = vaults
    .filter((v) => v.orgId === orgId)
    .map((v) => v.id)
  const analytics = await getOrgAnalyticsBatched(orgVaultIds)
  return { ...analytics, orgId, snapshotAt: utcNow() }
}
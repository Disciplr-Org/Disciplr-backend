import { describe, expect, it } from 'bun:test'
import {
  createAnalyticsBatchLoaders,
  getVaultMilestoneAnalytics,
  type VaultMilestoneAnalyticsBatchQuery,
} from '../../services/analytics.service.js'
import type { VaultMilestoneAnalyticsRow } from '../../db/database.js'

const makeRow = (
  vaultId: string,
  organizationId: string,
  overrides: Partial<VaultMilestoneAnalyticsRow> = {},
): VaultMilestoneAnalyticsRow => ({
  vault_id: vaultId,
  organization_id: organizationId,
  vault_status: 'active',
  vault_amount: '1000.0000000',
  milestone_count: 3,
  completed_milestones: 2,
  failed_milestones: 0,
  pending_milestones: 1,
  total_milestone_amount: '1000.0000000',
  completed_milestone_amount: '700.0000000',
  ...overrides,
})

const makeCountingQuery = (rows: VaultMilestoneAnalyticsRow[]) => {
  const calls: Array<{ vaultIds: string[]; organizationId: string | null | undefined }> = []

  const query: VaultMilestoneAnalyticsBatchQuery = async (vaultIds, organizationId) => {
    calls.push({ vaultIds: [...vaultIds], organizationId })
    return rows.filter((row) => (
      vaultIds.includes(row.vault_id) &&
      (organizationId == null || row.organization_id === organizationId)
    ))
  }

  return { calls, query }
}

describe('analytics batch resolver', () => {
  it('coalesces same-tick per-vault analytics reads and deduplicates repeated keys', async () => {
    const { calls, query } = makeCountingQuery([
      makeRow('vault-a', 'org-a'),
      makeRow('vault-b', 'org-a', { completed_milestones: 1, pending_milestones: 2 }),
    ])
    const loaders = createAnalyticsBatchLoaders({ organizationId: 'org-a', queryVaultMilestoneAnalytics: query })

    const [first, second, duplicate] = await Promise.all([
      loaders.vaultMilestoneAnalytics.load('vault-a'),
      loaders.vaultMilestoneAnalytics.load('vault-b'),
      loaders.vaultMilestoneAnalytics.load('vault-a'),
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.organizationId).toBe('org-a')
    expect(calls[0]!.vaultIds.sort()).toEqual(['vault-a', 'vault-b'])
    expect(first).toEqual(duplicate)
    expect(second).toMatchObject({
      vaultId: 'vault-b',
      completedMilestones: 1,
      pendingMilestones: 2,
      totalMilestoneAmount: '1000.0000000',
    })
  })

  it('reduces representative org analytics query count from one-per-vault to one batch query', async () => {
    const vaultIds = Array.from({ length: 50 }, (_, index) => `vault-${index}`)
    const { calls, query } = makeCountingQuery(vaultIds.map((vaultId) => makeRow(vaultId, 'org-a')))
    const loaders = createAnalyticsBatchLoaders({ organizationId: 'org-a', queryVaultMilestoneAnalytics: query })

    const results = await getVaultMilestoneAnalytics(vaultIds, loaders)

    expect(results).toHaveLength(vaultIds.length)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.vaultIds).toHaveLength(vaultIds.length)
    expect(calls.length).toBeLessThan(vaultIds.length)
  })

  it('preserves aggregate parity and returns zero aggregates for missing tenant-scoped rows', async () => {
    const { query } = makeCountingQuery([
      makeRow('vault-a', 'org-a', {
        vault_status: 'completed',
        vault_amount: '42.1250000',
        milestone_count: 4,
        completed_milestones: 3,
        failed_milestones: 1,
        pending_milestones: 0,
        total_milestone_amount: '42.1250000',
        completed_milestone_amount: '31.5000000',
      }),
    ])
    const loaders = createAnalyticsBatchLoaders({ organizationId: 'org-a', queryVaultMilestoneAnalytics: query })

    const [existing, missing] = await getVaultMilestoneAnalytics(['vault-a', 'vault-missing'], loaders)

    expect(existing).toEqual({
      vaultId: 'vault-a',
      organizationId: 'org-a',
      vaultStatus: 'completed',
      vaultAmount: '42.1250000',
      milestoneCount: 4,
      completedMilestones: 3,
      failedMilestones: 1,
      pendingMilestones: 0,
      totalMilestoneAmount: '42.1250000',
      completedMilestoneAmount: '31.5000000',
    })
    expect(missing).toEqual({
      vaultId: 'vault-missing',
      organizationId: 'org-a',
      vaultStatus: null,
      vaultAmount: '0',
      milestoneCount: 0,
      completedMilestones: 0,
      failedMilestones: 0,
      pendingMilestones: 0,
      totalMilestoneAmount: '0',
      completedMilestoneAmount: '0',
    })
  })

  it('does not leak cached analytics across tenant/request loader contexts', async () => {
    const { calls, query } = makeCountingQuery([
      makeRow('shared-vault-id', 'org-a', { vault_amount: '10.0000000' }),
      makeRow('shared-vault-id', 'org-b', { vault_amount: '999.0000000' }),
    ])
    const orgALoaders = createAnalyticsBatchLoaders({ organizationId: 'org-a', queryVaultMilestoneAnalytics: query })
    const orgBLoaders = createAnalyticsBatchLoaders({ organizationId: 'org-b', queryVaultMilestoneAnalytics: query })

    const [orgAResult, orgBResult] = await Promise.all([
      orgALoaders.vaultMilestoneAnalytics.load('shared-vault-id'),
      orgBLoaders.vaultMilestoneAnalytics.load('shared-vault-id'),
    ])

    expect(orgAResult.vaultAmount).toBe('10.0000000')
    expect(orgBResult.vaultAmount).toBe('999.0000000')
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.organizationId).sort()).toEqual(['org-a', 'org-b'])
  })
})

import { describe, expect, it, jest } from '@jest/globals'
import type { OrgVaultAnalytics } from '../services/analyticsBatchLoader.js'

interface VaultPageLike {
  vaults: Array<{ id: string }>
  nextCursor: string | null
  hasNextPage: boolean
}

type ListVaultsByOrg = (
  orgId: string,
  limit?: number,
  cursor?: string,
) => Promise<VaultPageLike>

type GetOrgAnalyticsBatched = (
  vaultIds: string[],
) => Promise<OrgVaultAnalytics>

const listVaultsByOrg = jest.fn<ListVaultsByOrg>()
const getOrgAnalyticsBatched = jest.fn<GetOrgAnalyticsBatched>()

jest.unstable_mockModule('../services/vaultStore.js', () => ({
  listVaultsByOrg,
}))

jest.unstable_mockModule('../services/analyticsBatchLoader.js', () => ({
  getOrgAnalyticsBatched,
}))

const { renderOrgAnalyticsSnapshot } = await import(
  '../services/analytics.service.js'
)

const ORG_ID = 'org-1'

function vault(id: string) {
  return { id, orgId: ORG_ID }
}

function analytics(overrides: Partial<OrgVaultAnalytics> = {}): OrgVaultAnalytics {
  return {
    totalVaults: 0,
    activeVaults: 0,
    completedVaults: 0,
    failedVaults: 0,
    totalLockedCapital: '0',
    successRate: 0,
    totalMilestones: 0,
    completedMilestones: 0,
    ...overrides,
  }
}

describe('renderOrgAnalyticsSnapshot', () => {
  it('resolves vault ids from vaultStore and returns the analytics snapshot', async () => {
    listVaultsByOrg.mockResolvedValue({
      vaults: [vault('vault-1'), vault('vault-2')],
      nextCursor: null,
      hasNextPage: false,
    })
    getOrgAnalyticsBatched.mockResolvedValue(
      analytics({
        totalVaults: 2,
        activeVaults: 1,
        completedVaults: 1,
        totalLockedCapital: '150',
        successRate: 1,
        totalMilestones: 3,
        completedMilestones: 2,
      }),
    )

    const snapshot = await renderOrgAnalyticsSnapshot(ORG_ID)

    expect(listVaultsByOrg).toHaveBeenCalledWith(ORG_ID, 100, undefined)
    expect(getOrgAnalyticsBatched).toHaveBeenCalledWith(['vault-1', 'vault-2'])
    expect(snapshot).toMatchObject({
      orgId: ORG_ID,
      totalVaults: 2,
      activeVaults: 1,
      completedVaults: 1,
      totalLockedCapital: '150',
      successRate: 1,
      totalMilestones: 3,
      completedMilestones: 2,
    })
    expect(typeof snapshot.snapshotAt).toBe('string')
  })

  it('walks every page of org vaults', async () => {
    listVaultsByOrg
      .mockResolvedValueOnce({
        vaults: [vault('vault-1')],
        nextCursor: 'cursor-1',
        hasNextPage: true,
      })
      .mockResolvedValueOnce({
        vaults: [vault('vault-2')],
        nextCursor: null,
        hasNextPage: false,
      })
    getOrgAnalyticsBatched.mockResolvedValue(analytics({ totalVaults: 2 }))

    await renderOrgAnalyticsSnapshot(ORG_ID)

    expect(listVaultsByOrg).toHaveBeenNthCalledWith(1, ORG_ID, 100, undefined)
    expect(listVaultsByOrg).toHaveBeenNthCalledWith(2, ORG_ID, 100, 'cursor-1')
    expect(getOrgAnalyticsBatched).toHaveBeenCalledWith(['vault-1', 'vault-2'])
  })

  it('merges aggregates when the vault ids are split into multiple batches', async () => {
    const vaults = Array.from({ length: 501 }, (_, i) => vault(`vault-${i}`))
    listVaultsByOrg.mockResolvedValue({
      vaults,
      nextCursor: null,
      hasNextPage: false,
    })
    getOrgAnalyticsBatched
      .mockResolvedValueOnce(
        analytics({
          totalVaults: 500,
          activeVaults: 300,
          completedVaults: 100,
          failedVaults: 100,
          totalLockedCapital: '5000',
          totalMilestones: 500,
          completedMilestones: 250,
        }),
      )
      .mockResolvedValueOnce(
        analytics({
          totalVaults: 1,
          activeVaults: 1,
          totalLockedCapital: '10',
        }),
      )

    const snapshot = await renderOrgAnalyticsSnapshot(ORG_ID)

    expect(getOrgAnalyticsBatched).toHaveBeenCalledTimes(2)
    expect(getOrgAnalyticsBatched.mock.calls[0][0]).toHaveLength(500)
    expect(getOrgAnalyticsBatched.mock.calls[1][0]).toEqual(['vault-500'])
    expect(snapshot).toMatchObject({
      totalVaults: 501,
      activeVaults: 301,
      completedVaults: 100,
      failedVaults: 100,
      totalLockedCapital: '5010',
      successRate: 0.5,
      totalMilestones: 500,
      completedMilestones: 250,
    })
  })

  it('returns a zeroed snapshot for an org without vaults', async () => {
    listVaultsByOrg.mockResolvedValue({
      vaults: [],
      nextCursor: null,
      hasNextPage: false,
    })
    getOrgAnalyticsBatched.mockResolvedValue(analytics())

    const snapshot = await renderOrgAnalyticsSnapshot(ORG_ID)

    expect(listVaultsByOrg).toHaveBeenCalledWith(ORG_ID, 100, undefined)
    expect(getOrgAnalyticsBatched).toHaveBeenCalledWith([])
    expect(snapshot).toMatchObject({
      orgId: ORG_ID,
      totalVaults: 0,
      totalLockedCapital: '0',
      successRate: 0,
    })
  })
})

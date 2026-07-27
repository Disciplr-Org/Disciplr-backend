import { beforeEach, describe, expect, it } from '@jest/globals'
import { getOrgRiskAnalytics } from '../services/analytics.service.js'

const ORG_ID = 'org-1'
const OTHER_ORG_ID = 'org-2'

describe('getOrgRiskAnalytics', () => {
  beforeEach(() => {
    // pure function — no shared mutable state
  })

  it('returns zeroed metrics when there are no vaults in the org', () => {
    const result = getOrgRiskAnalytics(ORG_ID, [])

    expect(result.analytics).toEqual({
      activeVaults: 0,
      capitalAtRisk: '0',
      resolvedVaults: 0,
      slashRate: 0,
      slashedVaults: 0,
      totalVaults: 0,
    })
  })

  it('excludes in-flight vaults from the slash-rate denominator and uses net staked amounts', () => {
    const result = getOrgRiskAnalytics(ORG_ID, [
      {
        id: 'v1',
        creator: 'alice',
        amount: '1000',
        status: 'active',
        startTimestamp: '2025-01-01T00:00:00Z',
        endTimestamp: '2025-02-01T00:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
        stakedAmount: '500',
        orgId: ORG_ID,
      },
      {
        id: 'v2',
        creator: 'alice',
        amount: '4000',
        status: 'completed',
        startTimestamp: '2025-01-01T00:00:00Z',
        endTimestamp: '2025-02-01T00:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
        stakedAmount: '4000',
        orgId: ORG_ID,
      },
      {
        id: 'v3',
        creator: 'alice',
        amount: '2000',
        status: 'failed',
        startTimestamp: '2025-01-01T00:00:00Z',
        endTimestamp: '2025-02-01T00:00:00Z',
        createdAt: '2025-01-02T00:00:00Z',
        stakedAmount: '2000',
        orgId: ORG_ID,
        resolution: 'slash_on_miss',
      },
      {
        id: 'v4',
        creator: 'alice',
        amount: '100',
        status: 'active',
        startTimestamp: '2025-02-01T00:00:00Z',
        endTimestamp: '2025-03-01T00:00:00Z',
        createdAt: '2025-02-01T00:00:00Z',
        stakedAmount: '100',
        orgId: ORG_ID,
      },
      {
        id: 'v5',
        creator: 'alice',
        amount: '6000',
        status: 'failed',
        startTimestamp: '2025-01-01T00:00:00Z',
        endTimestamp: '2025-02-01T00:00:00Z',
        createdAt: '2025-01-03T00:00:00Z',
        stakedAmount: '6000',
        orgId: OTHER_ORG_ID,
      },
    ])

    expect(result.analytics).toMatchObject({
      activeVaults: 2,
      capitalAtRisk: '600',
      resolvedVaults: 2,
      slashedVaults: 1,
      slashRate: 0.5,
      totalVaults: 4,
    })
  })

  it('treats the date range boundaries as inclusive UTC bounds', () => {
    const start = '2025-02-01T00:00:00.000Z'
    const end = '2025-02-01T23:59:59.999Z'

    const result = getOrgRiskAnalytics(
      ORG_ID,
      [
        {
          id: 'v1',
          creator: 'alice',
          amount: '1000',
          status: 'completed',
          startTimestamp: '2025-02-01T00:00:00Z',
          endTimestamp: '2025-02-02T00:00:00Z',
          createdAt: start,
          orgId: ORG_ID,
        },
        {
          id: 'v2',
          creator: 'alice',
          amount: '2000',
          status: 'failed',
          startTimestamp: '2025-02-01T23:59:59Z',
          endTimestamp: '2025-02-02T00:00:00Z',
          createdAt: end,
          orgId: ORG_ID,
        },
        {
          id: 'v3',
          creator: 'alice',
          amount: '3000',
          status: 'completed',
          startTimestamp: '2025-02-02T00:00:00Z',
          endTimestamp: '2025-02-03T00:00:00Z',
          createdAt: '2025-02-02T00:00:00Z',
          orgId: ORG_ID,
        },
      ],
      { startDate: start, endDate: end },
    )

    expect(result.analytics).toMatchObject({
      resolvedVaults: 2,
      totalVaults: 2,
      slashRate: 0.5,
      capitalAtRisk: '0',
    })
  })
})

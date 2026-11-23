// Register ESM mocks before dynamically importing the router.
import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { NextFunction, Request, Response } from 'express'
import type { OrgRiskAnalyticsVault } from '../services/analytics.service.js'

const mockListOrgVaultsForRiskAnalytics = jest.fn<
  (orgId: string) => Promise<OrgRiskAnalyticsVault[]>
>()

const allowOrgAccess = (
  _req: Request,
  _res: Response,
  next: NextFunction,
) => next()

jest.unstable_mockModule('../middleware/orgAuth.js', () => ({
  requireOrgAccess: () => allowOrgAccess,
  requireOrgRole: () => allowOrgAccess,
}))

jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  orgAnalyticsRateLimiter: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}))

jest.unstable_mockModule('../services/orgAnalytics.js', () => ({
  getOrgAnalytics: jest.fn(),
  listOrgVaultsForRiskAnalytics: mockListOrgVaultsForRiskAnalytics,
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

const { orgAnalyticsRouter } = await import('../routes/orgAnalytics.js')

const ORG_ID = 'org-1'
const OTHER_ORG_ID = 'org-2'

const app = express()
app.use(express.json())
app.use('/api/orgs', orgAnalyticsRouter)

function authHeader(userId: string) {
  const token = jwt.sign({ userId, role: 'ADMIN' }, process.env.JWT_SECRET ?? 'change-me-in-production')
  return `Bearer ${token}`
}

describe('GET /api/orgs/:orgId/analytics/risk', () => {
  beforeEach(() => {
    mockListOrgVaultsForRiskAnalytics.mockReset()
    mockListOrgVaultsForRiskAnalytics.mockResolvedValue([])
  })

  it('returns zeroed metrics when there are no vaults in the org', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/analytics/risk`)
      .set('Authorization', authHeader('alice'))

    expect(res.status).toBe(200)
    expect(res.body.analytics).toEqual({
      activeVaults: 0,
      capitalAtRisk: '0',
      resolvedVaults: 0,
      slashRate: 0,
      slashedVaults: 0,
      totalVaults: 0,
    })
  })

  it('excludes in-flight vaults from the slash-rate denominator and uses net staked amounts', async () => {
    mockListOrgVaultsForRiskAnalytics.mockResolvedValue([
      {
        id: 'active-vault',
        orgId: ORG_ID,
        status: 'active',
        amount: '100',
        netStakedAmount: '80',
      },
      {
        id: 'pending-vault',
        orgId: ORG_ID,
        status: 'pending',
        amount: '50',
      },
      {
        id: 'completed-vault',
        orgId: ORG_ID,
        status: 'completed',
      },
      {
        id: 'slashed-vault',
        orgId: ORG_ID,
        status: 'failed',
        resolution: 'slash_on_miss',
      },
      {
        id: 'other-org-vault',
        orgId: OTHER_ORG_ID,
        status: 'failed',
        resolution: 'slash',
      },
    ])

    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/analytics/risk`)
      .set('Authorization', authHeader('alice'))

    expect(res.status).toBe(200)
    expect(res.body.analytics).toBeDefined()
    expect(res.body.analytics).toEqual({
      activeVaults: 1,
      capitalAtRisk: '80',
      resolvedVaults: 2,
      slashRate: 0.5,
      slashedVaults: 1,
      totalVaults: 4,
    })
  })

  it('treats the date range boundaries as inclusive UTC bounds', async () => {
    const start = '2025-02-01T00:00:00.000Z'
    const end = '2025-02-01T23:59:59.999Z'

    mockListOrgVaultsForRiskAnalytics.mockResolvedValue([
      {
        id: 'at-start',
        orgId: ORG_ID,
        status: 'completed',
        createdAt: start,
      },
      {
        id: 'at-end',
        orgId: ORG_ID,
        status: 'failed',
        resolution: 'slashed',
        createdAt: end,
      },
      {
        id: 'before-range',
        orgId: ORG_ID,
        status: 'active',
        amount: '10',
        createdAt: '2025-01-31T23:59:59.999Z',
      },
      {
        id: 'after-range',
        orgId: ORG_ID,
        status: 'active',
        amount: '20',
        createdAt: '2025-02-02T00:00:00.000Z',
      },
      {
        id: 'other-org-at-boundary',
        orgId: OTHER_ORG_ID,
        status: 'failed',
        resolution: 'slashed',
        createdAt: start,
      },
    ])

    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/analytics/risk`)
      .query({ startDate: start, endDate: end })
      .set('Authorization', authHeader('alice'))

    expect(res.status).toBe(200)
    expect(res.body.analytics).toBeDefined()
    expect(res.body.range).toEqual({ startDate: start, endDate: end })
    expect(res.body.analytics).toEqual({
      activeVaults: 0,
      capitalAtRisk: '0',
      resolvedVaults: 2,
      slashRate: 0.5,
      slashedVaults: 1,
      totalVaults: 2,
    })
  })
})

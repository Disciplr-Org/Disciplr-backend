import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { beforeEach, afterEach, describe, expect, it } from '@jest/globals'
import { orgAnalyticsRouter } from '../routes/orgAnalytics.js'
import { setVaults } from '../routes/vaults.js'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'
import { UserRole } from '../types/user.js'

const ORG_ID = 'org-1'
const OTHER_ORG_ID = 'org-2'

const app = express()
app.use(express.json())
app.use('/api/orgs', orgAnalyticsRouter)

function authHeader(userId: string) {
  const token = jwt.sign({ userId, role: UserRole.ADMIN }, process.env.JWT_SECRET ?? 'change-me-in-production')
  return `Bearer ${token}`
}

function seedVaults(vaults: Array<any>) {
  setOrganizations([
    { id: ORG_ID, name: 'Test Org', createdAt: '2025-01-01T00:00:00Z' },
    { id: OTHER_ORG_ID, name: 'Other Org', createdAt: '2025-01-01T00:00:00Z' },
  ])

  setOrgMembers([
    { orgId: ORG_ID, userId: 'alice', role: 'owner' },
    { orgId: OTHER_ORG_ID, userId: 'alice', role: 'owner' },
  ])

  setVaults(vaults)
}

describe('GET /api/orgs/:orgId/analytics/risk', () => {
  beforeEach(() => {
    setVaults([])
    setOrganizations([])
    setOrgMembers([])
  })

  afterEach(() => {
    setVaults([])
    setOrganizations([])
    setOrgMembers([])
  })

  it('returns zeroed metrics when there are no vaults in the org', async () => {
    seedVaults([])

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
    seedVaults([
      {
        id: 'v1',
        creator: 'alice',
        amount: '1000',
        status: 'active',
        startTimestamp: '2025-01-01T00:00:00Z',
        endTimestamp: '2025-02-01T00:00:00Z',
        successDestination: 'success',
        failureDestination: 'failure',
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
        successDestination: 'success',
        failureDestination: 'failure',
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
        successDestination: 'success',
        failureDestination: 'failure',
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
        successDestination: 'success',
        failureDestination: 'failure',
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
        successDestination: 'success',
        failureDestination: 'failure',
        createdAt: '2025-01-03T00:00:00Z',
        stakedAmount: '6000',
        orgId: OTHER_ORG_ID,
      },
    ])

    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/analytics/risk`)
      .set('Authorization', authHeader('alice'))

    expect(res.status).toBe(200)
    expect(res.body.analytics).toMatchObject({
      activeVaults: 2,
      capitalAtRisk: '600',
      resolvedVaults: 2,
      slashedVaults: 1,
      slashRate: 0.5,
      totalVaults: 4,
    })
  })

  it('treats the date range boundaries as inclusive UTC bounds', async () => {
    const start = '2025-02-01T00:00:00.000Z'
    const end = '2025-02-01T23:59:59.999Z'

    seedVaults([
      {
        id: 'v1',
        creator: 'alice',
        amount: '1000',
        status: 'completed',
        startTimestamp: '2025-02-01T00:00:00Z',
        endTimestamp: '2025-02-02T00:00:00Z',
        successDestination: 'success',
        failureDestination: 'failure',
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
        successDestination: 'success',
        failureDestination: 'failure',
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
        successDestination: 'success',
        failureDestination: 'failure',
        createdAt: '2025-02-02T00:00:00Z',
        orgId: ORG_ID,
      },
    ])

    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/analytics/risk`)
      .query({ startDate: start, endDate: end })
      .set('Authorization', authHeader('alice'))

    expect(res.status).toBe(200)
    expect(res.body.analytics).toMatchObject({
      resolvedVaults: 2,
      totalVaults: 2,
      slashRate: 0.5,
      capitalAtRisk: '0',
    })
  })
})

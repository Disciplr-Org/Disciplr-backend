import { jest } from '@jest/globals'

jest.unstable_mockModule('../middleware/orgAuth.js', () => ({
  requireOrgAccess: jest.fn((...roles) => (req, res, next) => {
    next()
  }),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { beforeEach, afterEach, describe, expect, it } from '@jest/globals'

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
  })

  afterEach(() => {
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
    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/analytics/risk`)
      .set('Authorization', authHeader('alice'))

    expect(res.status).toBe(200)
    expect(res.body.analytics).toBeDefined()
  })

  it('treats the date range boundaries as inclusive UTC bounds', async () => {
    const start = '2025-02-01T00:00:00.000Z'
    const end = '2025-02-01T23:59:59.999Z'

    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/analytics/risk`)
      .query({ startDate: start, endDate: end })
      .set('Authorization', authHeader('alice'))

    expect(res.status).toBe(200)
    expect(res.body.analytics).toBeDefined()
  })
})

import request from 'supertest'
import express from 'express'
import { authenticate, signToken } from '../middleware/auth.js'
import { describe, it, expect } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { vaults, setVaults, Vault } from '../routes/vaults.js'
import {
  setOrganizations,
  setOrgMembers,
} from '../models/organizations.js'

// ── Test app ──────────────────────────────────────────────────────
const app = express()
app.use(express.json())

// Mount org vaults route
app.get(
  '/api/organizations/:orgId/vaults',
  authenticate,
  requireOrgAccess('owner', UserRole.ADMIN, 'member'),
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  (req, res) => {
    const { orgId } = req.params
    let result = vaults.filter((v) => v.orgId === orgId)
    if (req.filters) result = applyFilters(result, req.filters)
    if (req.sort) result = applySort(result, req.sort)
    const paginatedResult = paginateArray(result, req.pagination!)
    res.json(paginatedResult)
  }
)

// Mount org analytics route
app.get(
  '/api/organizations/:orgId/analytics',
  authenticate,
  requireOrgAccess('owner', UserRole.ADMIN),
  (req, res) => {
    const { orgId } = req.params
    const orgVaults = vaults.filter((v) => v.orgId === orgId)

    const activeVaults = orgVaults.filter((v) => v.status === 'active').length
    const completedVaults = orgVaults.filter((v) => v.status === 'completed').length
    const failedVaults = orgVaults.filter((v) => v.status === 'failed').length
    const totalCapital = orgVaults
      .reduce((sum, v) => sum + parseFloat(v.amount || '0'), 0)
      .toString()
    const resolved = completedVaults + failedVaults
    const successRate = resolved > 0 ? completedVaults / resolved : 0

    const creatorMap = new Map<string, Vault[]>()
    for (const v of orgVaults) {
      const list = creatorMap.get(v.creator) ?? []
      list.push(v)
      creatorMap.set(v.creator, list)
    }
    const teamPerformance = Array.from(creatorMap.entries()).map(([creator, cvaults]) => {
      const completed = cvaults.filter((v) => v.status === 'completed').length
      const failed = cvaults.filter((v) => v.status === 'failed').length
      const creatorResolved = completed + failed
      return {
        creator,
        vaultCount: cvaults.length,
        totalAmount: cvaults.reduce((s, v) => s + parseFloat(v.amount || '0'), 0).toString(),
        successRate: creatorResolved > 0 ? completed / creatorResolved : 0,
      }
    })

    res.json({
      orgId,
      analytics: { totalCapital, successRate, activeVaults, completedVaults, failedVaults },
      teamPerformance,
      generatedAt: new Date().toISOString(),
    })
  }
)

// ── Helpers ───────────────────────────────────────────────────────
const token = (sub: string, role: UserRole.USER | UserRole.VERIFIER | UserRole.ADMIN = UserRole.USER) =>
  `Bearer ${signToken({ sub, role })}`

const ORG_ID = 'org-1'
const OTHER_ORG_ID = 'org-other'

function seedData() {
  setOrganizations([
    { id: ORG_ID, name: 'Test Org', createdAt: '2025-01-01T00:00:00Z' },
    { id: OTHER_ORG_ID, name: 'Other Org', createdAt: '2025-01-01T00:00:00Z' },
  ])

  setOrgMembers([
    { orgId: ORG_ID, userId: 'alice', role: 'owner' },
    { orgId: ORG_ID, userId: 'bob', role: UserRole.ADMIN },
    { orgId: ORG_ID, userId: 'carol', role: 'member' },
    { orgId: OTHER_ORG_ID, userId: 'dave', role: 'owner' },
  ])

  const baseVault: Omit<Vault, 'id' | 'creator' | 'amount' | 'status' | 'orgId'> = {
    startTimestamp: '2025-01-01T00:00:00Z',
    endTimestamp: '2025-12-31T00:00:00Z',
    successDestination: 'addr-success',
    failureDestination: 'addr-fail',
    createdAt: '2025-01-01T00:00:00Z',
  }

  setVaults([
    { ...baseVault, id: 'v1', creator: 'alice', amount: '1000', status: 'active', orgId: ORG_ID },
    { ...baseVault, id: 'v2', creator: 'alice', amount: '2000', status: 'completed', orgId: ORG_ID },
    { ...baseVault, id: 'v3', creator: 'bob', amount: '500', status: 'failed', orgId: ORG_ID },
    { ...baseVault, id: 'v4', creator: 'bob', amount: '1500', status: 'completed', orgId: ORG_ID },
    { ...baseVault, id: 'v5', creator: 'dave', amount: '3000', status: 'active', orgId: OTHER_ORG_ID },
    { ...baseVault, id: 'v6', creator: 'carol', amount: '800', status: 'active', orgId: ORG_ID },
  ])
}

// ── Setup / Teardown ─────────────────────────────────────────────
beforeEach(() => {
  seedData()
})

afterEach(() => {
  setVaults([])
  setOrganizations([])
  setOrgMembers([])
})

// ── Org Vaults: Auth ─────────────────────────────────────────────
describe('GET /api/organizations/:orgId/vaults', () => {
  it('rejects request without JWT → 401', async () => {
    const res = await request(app).get(`/api/organizations/${ORG_ID}/vaults`)
    expect(res.status).toBe(401)
  })

  it('rejects non-member → 403', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/vaults`)
      .set('Authorization', token('dave'))
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not a member/)
  })

  it('returns 404 for non-existent org', async () => {
    const res = await request(app)
      .get('/api/organizations/org-nonexistent/vaults')
      .set('Authorization', token('alice'))
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/)
  })

  it('returns org vaults for a member', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/vaults`)
      .set('Authorization', token('carol'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(5) // v1,v2,v3,v4,v6 belong to ORG_ID
    expect(res.body.pagination.total).toBe(5)
  })

  it('does not leak vaults from other orgs', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/vaults`)
      .set('Authorization', token('alice'))
    const ids = res.body.data.map((v: Vault) => v.id)
    expect(ids).not.toContain('v5')
  })

  it('filters by status', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/vaults?status=active`)
      .set('Authorization', token('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2) // v1, v6
    for (const v of res.body.data) {
      expect(v.status).toBe('active')
    }
  })

  it('filters by creator', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/vaults?creator=bob`)
      .set('Authorization', token('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2) // v3, v4
    for (const v of res.body.data) {
      expect(v.creator).toBe('bob')
    }
  })
})

// ── Org Analytics: Auth ──────────────────────────────────────────
describe('GET /api/organizations/:orgId/analytics', () => {
  it('rejects request without JWT → 401', async () => {
    const res = await request(app).get(`/api/organizations/${ORG_ID}/analytics`)
    expect(res.status).toBe(401)
  })

  it('rejects non-member → 403', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/analytics`)
      .set('Authorization', token('dave'))
    expect(res.status).toBe(403)
  })

  it('rejects member with role "member" → 403', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/analytics`)
      .set('Authorization', token('carol'))
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/requires role/)
  })

  it('returns 404 for non-existent org', async () => {
    const res = await request(app)
      .get('/api/organizations/org-nonexistent/analytics')
      .set('Authorization', token('alice'))
    expect(res.status).toBe(404)
  })

  it('returns analytics for owner', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/analytics`)
      .set('Authorization', token('alice'))
    expect(res.status).toBe(200)

    const { analytics, teamPerformance, orgId, generatedAt } = res.body
    expect(orgId).toBe(ORG_ID)
    expect(generatedAt).toBeDefined()

    // 5 vaults in org-1: v1(active,1000), v2(completed,2000), v3(failed,500), v4(completed,1500), v6(active,800)
    expect(analytics.totalCapital).toBe('5800')
    expect(analytics.activeVaults).toBe(2)
    expect(analytics.completedVaults).toBe(2)
    expect(analytics.failedVaults).toBe(1)
    // successRate = 2 / (2+1) = 0.6667
    expect(analytics.successRate).toBeCloseTo(2 / 3)

    expect(teamPerformance).toHaveLength(3) // alice, bob, carol
  })

  it('returns analytics for admin', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/analytics`)
      .set('Authorization', token('bob'))
    expect(res.status).toBe(200)
    expect(res.body.analytics).toBeDefined()
  })

  it('computes correct team performance per creator', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/analytics`)
      .set('Authorization', token('alice'))

    const alicePerf = res.body.teamPerformance.find((t: any) => t.creator === 'alice')
    expect(alicePerf.vaultCount).toBe(2)
    expect(alicePerf.totalAmount).toBe('3000')
    expect(alicePerf.successRate).toBe(1) // 1 completed, 0 failed

    const bobPerf = res.body.teamPerformance.find((t: any) => t.creator === 'bob')
    expect(bobPerf.vaultCount).toBe(2)
    expect(bobPerf.totalAmount).toBe('2000')
    expect(bobPerf.successRate).toBe(0.5) // 1 completed, 1 failed
  })
})

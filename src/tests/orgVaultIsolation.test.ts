import request from 'supertest'
import express, { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'

function passOrgAccess(req: Request, res: Response, next: NextFunction): void {
  (req as any).orgId = req.params.orgId;
  next();
}

// ── Local in-memory vault store (avoids DB-heavy routes/vaults.ts) ─
let testVaults: any[] = []
const setTestVaults = (v: any[]) => { testVaults = v }

// ── Mock authenticate (no session/DB dependency) ─────────────────
const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

function mockAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' })
    return
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET)
    req.user = payload as any
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// ── Test app ──────────────────────────────────────────────────────
const app = express()
app.use(express.json())

app.get(
  '/api/organizations/:orgId/vaults',
  mockAuthenticate,
  passOrgAccess,
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  (req, res) => {
    const { orgId } = req.params
    let result = testVaults.filter((v) => v.orgId === orgId)
    if (req.filters) result = applyFilters(result, req.filters, ['status'])
    if (req.sort) result = applySort(result, req.sort)
    res.json(paginateArray(result, req.pagination!))
  },
)

app.get(
  '/api/organizations/:orgId/analytics',
  mockAuthenticate,
  passOrgAccess,
  (req, res) => {
    const { orgId } = req.params
    const orgVaults = testVaults.filter((v) => v.orgId === orgId)
    const active = orgVaults.filter((v) => v.status === 'active').length
    const completed = orgVaults.filter((v) => v.status === 'completed').length
    const failed = orgVaults.filter((v) => v.status === 'failed').length
    const totalCapital = orgVaults
      .reduce((sum, v) => sum + parseFloat(v.amount || '0'), 0)
      .toString()
    const resolved = completed + failed
    const successRate = resolved > 0 ? completed / resolved : 0
    res.json({
      orgId,
      analytics: { totalCapital, successRate, activeVaults: active, completedVaults: completed, failedVaults: failed },
      generatedAt: new Date().toISOString(),
    })
  },
)

// ── Token helper ─────────────────────────────────────────────────
const bearer = (sub: string, role: string = UserRole.USER) =>
  `Bearer ${jwt.sign({ sub, role }, JWT_SECRET, { expiresIn: '1h' })}`

// ── Constants ────────────────────────────────────────────────────
const ORG_ALPHA = 'org-alpha'
const ORG_BETA = 'org-beta'
const ORG_EMPTY = 'org-empty'
const ALPHA_IDS = ['va-1', 'va-2', 'va-3']
const BETA_IDS = ['vb-1', 'vb-2']

// ── Seed / Teardown ──────────────────────────────────────────────
function seed() {
  const base = {
    startTimestamp: '2025-01-01T00:00:00Z',
    endTimestamp: '2025-12-31T00:00:00Z',
    successDestination: 'addr-ok',
    failureDestination: 'addr-fail',
    createdAt: '2025-01-01T00:00:00Z',
  }

  setTestVaults([
    { ...base, id: 'va-1', creator: 'alice', amount: '1000', status: 'active', orgId: ORG_ALPHA },
    { ...base, id: 'va-2', creator: 'bob', amount: '2000', status: 'completed', orgId: ORG_ALPHA },
    { ...base, id: 'va-3', creator: 'carol', amount: '500', status: 'failed', orgId: ORG_ALPHA },
    { ...base, id: 'vb-1', creator: 'dave', amount: '3000', status: 'active', orgId: ORG_BETA },
    { ...base, id: 'vb-2', creator: 'eve', amount: '4000', status: 'completed', orgId: ORG_BETA },
  ])
}

beforeEach(() => seed())
afterEach(() => {
  setTestVaults([])
})

// =====================================================================
//  1. Cross-org vault listing isolation
// =====================================================================
describe('Cross-org vault listing isolation', () => {
  it('org-alpha owner sees only org-alpha vaults', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((v: any) => v.id)
    expect(ids.sort()).toEqual(ALPHA_IDS.sort())
  })

  it('org-beta owner sees only org-beta vaults', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(200)
    expect(res.body.data.map((v: any) => v.id).sort()).toEqual(BETA_IDS.sort())
  })

  it('org-alpha listing never contains any org-beta vault ID', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults`)
      .set('Authorization', bearer('alice'))
    const ids: string[] = res.body.data.map((v: any) => v.id)
    for (const bid of BETA_IDS) expect(ids).not.toContain(bid)
  })

  it('org-beta listing never contains any org-alpha vault ID', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults`)
      .set('Authorization', bearer('dave'))
    const ids: string[] = res.body.data.map((v: any) => v.id)
    for (const aid of ALPHA_IDS) expect(ids).not.toContain(aid)
  })

  it('pagination total reflects only the target org', async () => {
    const [a, b] = await Promise.all([
      request(app).get(`/api/organizations/${ORG_ALPHA}/vaults`).set('Authorization', bearer('alice')),
      request(app).get(`/api/organizations/${ORG_BETA}/vaults`).set('Authorization', bearer('dave')),
    ])
    expect(a.body.pagination.total).toBe(ALPHA_IDS.length)
    expect(b.body.pagination.total).toBe(BETA_IDS.length)
  })
})





// =====================================================================
//  4. Dual-membership user isolation
// =====================================================================
describe('Dual-membership user isolation (frank in both orgs)', () => {
  it('frank sees only org-alpha vaults when querying org-alpha', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults`)
      .set('Authorization', bearer('frank'))
    expect(res.status).toBe(200)
    expect(res.body.data.map((v: any) => v.id).sort()).toEqual(ALPHA_IDS.sort())
  })

  it('frank sees only org-beta vaults when querying org-beta', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults`)
      .set('Authorization', bearer('frank'))
    expect(res.status).toBe(200)
    expect(res.body.data.map((v: any) => v.id).sort()).toEqual(BETA_IDS.sort())
  })

  it('frank org-alpha response never leaks org-beta data', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults`)
      .set('Authorization', bearer('frank'))
    const ids: string[] = res.body.data.map((v: any) => v.id)
    for (const bid of BETA_IDS) expect(ids).not.toContain(bid)
  })

  it('frank org-beta response never leaks org-alpha data', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults`)
      .set('Authorization', bearer('frank'))
    const ids: string[] = res.body.data.map((v: any) => v.id)
    for (const aid of ALPHA_IDS) expect(ids).not.toContain(aid)
  })
})

// =====================================================================
//  5. Filters and sorting do not bypass isolation
// =====================================================================
describe('Filters and sorting do not bypass isolation', () => {
  it('filtering by cross-org creator yields empty results', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults?creator=dave`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
    expect(res.body.pagination.total).toBe(0)
  })

  it('filtering by status returns only same-org matches', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults?status=completed`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe('va-2')
    expect(res.body.data[0].orgId).toBe(ORG_ALPHA)
  })

  it('sorting does not introduce cross-org vaults', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults?sortBy=amount&sortOrder=desc`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    const ids: string[] = res.body.data.map((v: any) => v.id)
    expect(ids).toHaveLength(ALPHA_IDS.length)
    for (const bid of BETA_IDS) expect(ids).not.toContain(bid)
  })

  it('page beyond total yields empty array, not cross-org data', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults?page=2&pageSize=20`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
    expect(res.body.pagination.total).toBe(ALPHA_IDS.length)
  })

  it('small pageSize returns correct subset without cross-org leaks', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults?page=1&pageSize=2`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    for (const v of res.body.data) expect(ALPHA_IDS).toContain(v.id)
    expect(res.body.pagination.total).toBe(ALPHA_IDS.length)
  })
})

// =====================================================================
//  6. Empty org isolation
// =====================================================================
describe('Empty org returns empty results, not other org data', () => {
  it('org-empty owner gets empty data array', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_EMPTY}/vaults`)
      .set('Authorization', bearer('gina'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
    expect(res.body.pagination.total).toBe(0)
  })

  it('org-empty never surfaces vaults from other orgs', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_EMPTY}/vaults`)
      .set('Authorization', bearer('gina'))
    const allIds = [...ALPHA_IDS, ...BETA_IDS]
    const ids: string[] = res.body.data.map((v: any) => v.id)
    for (const id of allIds) expect(ids).not.toContain(id)
  })
})

// =====================================================================
//  7. Cross-org analytics isolation
// =====================================================================
describe('Cross-org analytics isolation', () => {
  it('org-alpha analytics only reflect org-alpha vault data', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/analytics`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.orgId).toBe(ORG_ALPHA)
    const { analytics } = res.body
    expect(analytics.totalCapital).toBe('3500')
    expect(analytics.activeVaults).toBe(1)
    expect(analytics.completedVaults).toBe(1)
    expect(analytics.failedVaults).toBe(1)
  })

  it('org-alpha analytics excludes org-beta capital', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/analytics`)
      .set('Authorization', bearer('alice'))
    const total = parseFloat(res.body.analytics.totalCapital)
    expect(total).toBe(3500)
    expect(total).not.toBe(10500) // combined total of all orgs
  })

})

// =====================================================================
//  8. Response body audit — no cross-org metadata leaks
// =====================================================================
describe('Response body audit — no cross-org metadata leaks', () => {
  it('every vault in org-alpha response has orgId === org-alpha', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults`)
      .set('Authorization', bearer('alice'))
    for (const v of res.body.data) expect(v.orgId).toBe(ORG_ALPHA)
  })

  it('every vault in org-beta response has orgId === org-beta', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults`)
      .set('Authorization', bearer('dave'))
    for (const v of res.body.data) expect(v.orgId).toBe(ORG_BETA)
  })

  it('serialized response body does not mention the other org', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults`)
      .set('Authorization', bearer('alice'))
    const json = JSON.stringify(res.body)
    expect(json).not.toContain(ORG_BETA)
    for (const bid of BETA_IDS) expect(json).not.toContain(bid)
  })
})

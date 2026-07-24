import request from 'supertest'
import express, { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray, encodeCursor, decodeCursor } from '../utils/pagination.js'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'

// ── Test stores ──────────────────────────────────────────────────────────
let testVaults: any[] = []
let testMilestones: any[] = []
let testSavedSearches: any[] = []

const setTestVaults = (v: any[]) => { testVaults = v }
const setTestMilestones = (m: any[]) => { testMilestones = m }
const setTestSavedSearches = (s: any[]) => { testSavedSearches = s }

// ── Mock authenticate ───────────────────────────────────────────────────
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

// ── Test app with relevant vault/milestone/evidence/export routes ────────
const app = express()
app.use(express.json())

// ------------------------------
// Vault Routes
// ------------------------------
app.get(
  '/api/organizations/:orgId/vaults',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  queryParser({ allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'], allowedFilterFields: ['status', 'creator'] }),
  (req, res) => {
    const { orgId } = req.params
    let result = testVaults.filter((v) => v.orgId === orgId)
    if (req.filters) result = applyFilters(result, req.filters)
    if (req.sort) result = applySort(result, req.sort)
    res.json(paginateArray(result, req.pagination!))
  }
)

app.get(
  '/api/organizations/:orgId/vaults/:id',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req, res) => {
    const { orgId, id } = req.params
    const vault = testVaults.find((v) => v.id === id && v.orgId === orgId)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    res.json(vault)
  }
)

app.patch(
  '/api/organizations/:orgId/vaults/:id',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req, res) => {
    const { orgId, id } = req.params
    const vaultIndex = testVaults.findIndex((v) => v.id === id && v.orgId === orgId)
    if (vaultIndex === -1) return res.status(404).json({ error: 'Vault not found' })
    testVaults[vaultIndex] = { ...testVaults[vaultIndex], ...req.body }
    res.json(testVaults[vaultIndex])
  }
)

app.post(
  '/api/organizations/:orgId/vaults/:id/cancel',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req, res) => {
    const { orgId, id } = req.params
    const vaultIndex = testVaults.findIndex((v) => v.id === id && v.orgId === orgId)
    if (vaultIndex === -1) return res.status(404).json({ error: 'Vault not found' })
    testVaults[vaultIndex].status = 'cancelled'
    res.json({ message: 'Vault cancelled', id })
  }
)

app.get(
  '/api/organizations/:orgId/vaults/:id/timeline',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req, res) => {
    const { orgId, id } = req.params
    const vault = testVaults.find((v) => v.id === id && v.orgId === orgId)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    res.json({ timeline: [] })
  }
)

app.get(
  '/api/organizations/:orgId/vaults/search',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req, res) => {
    const { orgId } = req.params
    let result = testVaults.filter((v) => v.orgId === orgId)
    if (req.query.q) {
      const q = req.query.q as string
      result = result.filter((v) => 
        v.creator.includes(q) || (v.verifier && v.verifier.includes(q))
      )
    }
    const limit = parseInt((req.query.limit as string) || '20', 10)
    const hasMore = result.length > limit
    const data = result.slice(0, limit)
    let nextCursor: string | undefined
    if (hasMore && data.length > 0) {
      nextCursor = encodeCursor(new Date(data[data.length - 1].createdAt), data[data.length - 1].id)
    }
    res.json({ data, pagination: { limit, hasMore, nextCursor } })
  }
)

// ------------------------------
// Saved Searches Routes
// ------------------------------
app.post(
  '/api/organizations/:orgId/vault-searches',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin'),
  (req, res) => {
    const { orgId } = req.params
    const search = { id: req.body.id || 'search-' + Date.now(), orgId, ...req.body }
    testSavedSearches.push(search)
    res.status(201).json({ search })
  }
)

app.get(
  '/api/organizations/:orgId/vault-searches/:searchId',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req, res) => {
    const { orgId, searchId } = req.params
    const search = testSavedSearches.find((s) => s.id === searchId && s.orgId === orgId)
    if (!search) return res.status(404).json({ error: 'Saved search not found' })
    res.json({ search })
  }
)

app.delete(
  '/api/organizations/:orgId/vault-searches/:searchId',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin'),
  (req, res) => {
    const { orgId, searchId } = req.params
    const initialLength = testSavedSearches.length
    testSavedSearches = testSavedSearches.filter((s) => !(s.id === searchId && s.orgId === orgId))
    if (testSavedSearches.length === initialLength) return res.status(404).json({ error: 'Saved search not found' })
    res.status(204).end()
  }
)

// ------------------------------
// Milestone Routes
// ------------------------------
app.get(
  '/api/organizations/:orgId/vaults/:vaultId/milestones',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req, res) => {
    const { orgId, vaultId } = req.params
    const vault = testVaults.find((v) => v.id === vaultId && v.orgId === orgId)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    const milestones = testMilestones.filter((m) => m.vaultId === vaultId)
    res.json({ milestones })
  }
)

app.get(
  '/api/organizations/:orgId/vaults/:vaultId/milestones/:id',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req, res) => {
    const { orgId, vaultId, id } = req.params
    const vault = testVaults.find((v) => v.id === vaultId && v.orgId === orgId)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    const milestone = testMilestones.find((m) => m.id === id && m.vaultId === vaultId)
    if (!milestone) return res.status(404).json({ error: 'Milestone not found' })
    res.json(milestone)
  }
)

// ── Token helper ──────────────────────────────────────────────────────────
const bearer = (sub: string, role: string = UserRole.USER) =>
  `Bearer ${jwt.sign({ sub, userId: sub, role }, JWT_SECRET, { expiresIn: '1h' })}`

// ── Constants ─────────────────────────────────────────────────────────────
const ORG_ALPHA = 'org-alpha'
const ORG_BETA = 'org-beta'
const ORG_EMPTY = 'org-empty'

// Alpha Org Entities
const ALPHA_VAULT_IDS = ['va-1', 'va-2', 'va-3']
const ALPHA_MILESTONE_IDS = ['ma-1', 'ma-2', 'ma-3']
const ALPHA_SEARCH_ID = 'sa-1'

// Beta Org Entities
const BETA_VAULT_IDS = ['vb-1', 'vb-2']
const BETA_MILESTONE_IDS = ['mb-1', 'mb-2']
const BETA_SEARCH_ID = 'sb-1'

// ── Seed / Teardown ───────────────────────────────────────────────────────
function seed() {
  setOrganizations([
    { id: ORG_ALPHA, name: 'Alpha Corp', createdAt: '2025-01-01T00:00:00Z' },
    { id: ORG_BETA, name: 'Beta Inc', createdAt: '2025-02-01T00:00:00Z' },
    { id: ORG_EMPTY, name: 'Empty LLC', createdAt: '2025-03-01T00:00:00Z' },
  ])

  setOrgMembers([
    { orgId: ORG_ALPHA, userId: 'alice', role: 'owner' },
    { orgId: ORG_ALPHA, userId: 'bob', role: 'admin' },
    { orgId: ORG_ALPHA, userId: 'carol', role: 'member' },
    { orgId: ORG_BETA, userId: 'dave', role: 'owner' },
    { orgId: ORG_BETA, userId: 'eve', role: 'member' },
    { orgId: ORG_ALPHA, userId: 'frank', role: 'member' },
    { orgId: ORG_BETA, userId: 'frank', role: 'member' },
  ])

  const baseVault = {
    startTimestamp: '2025-01-01T00:00:00Z',
    endTimestamp: '2025-12-31T00:00:00Z',
    successDestination: 'addr-ok',
    failureDestination: 'addr-fail',
    createdAt: '2025-01-01T00:00:00Z',
  }

  setTestVaults([
    { ...baseVault, id: ALPHA_VAULT_IDS[0], creator: 'alice', amount: '1000', status: 'active', orgId: ORG_ALPHA },
    { ...baseVault, id: ALPHA_VAULT_IDS[1], creator: 'bob', amount: '2000', status: 'completed', orgId: ORG_ALPHA },
    { ...baseVault, id: ALPHA_VAULT_IDS[2], creator: 'carol', amount: '500', status: 'failed', orgId: ORG_ALPHA },
    { ...baseVault, id: BETA_VAULT_IDS[0], creator: 'dave', amount: '3000', status: 'active', orgId: ORG_BETA },
    { ...baseVault, id: BETA_VAULT_IDS[1], creator: 'eve', amount: '4000', status: 'completed', orgId: ORG_BETA },
  ])

  setTestMilestones([
    { id: ALPHA_MILESTONE_IDS[0], vaultId: ALPHA_VAULT_IDS[0], description: 'Milestone 1', verified: false },
    { id: ALPHA_MILESTONE_IDS[1], vaultId: ALPHA_VAULT_IDS[0], description: 'Milestone 2', verified: true },
    { id: ALPHA_MILESTONE_IDS[2], vaultId: ALPHA_VAULT_IDS[1], description: 'Milestone 3', verified: false },
    { id: BETA_MILESTONE_IDS[0], vaultId: BETA_VAULT_IDS[0], description: 'Milestone B1', verified: false },
    { id: BETA_MILESTONE_IDS[1], vaultId: BETA_VAULT_IDS[1], description: 'Milestone B2', verified: true },
  ])

  setTestSavedSearches([
    { id: ALPHA_SEARCH_ID, orgId: ORG_ALPHA, name: 'Alpha Search', queryDefinition: { status: 'active' } },
    { id: BETA_SEARCH_ID, orgId: ORG_BETA, name: 'Beta Search', queryDefinition: { status: 'completed' } },
  ])
}

beforeEach(() => seed())
afterEach(() => {
  setTestVaults([])
  setTestMilestones([])
  setTestSavedSearches([])
  setOrganizations([])
  setOrgMembers([])
})

// =====================================================================
//  1. Vault IDOR Tests
// =====================================================================
describe('Vault IDOR Tests', () => {
  it('org-beta user cannot read org-alpha vault by ID → 404', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults/${ALPHA_VAULT_IDS[0]}`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(404)
  })

  it('org-beta user cannot patch org-alpha vault by ID → 404', async () => {
    const res = await request(app)
      .patch(`/api/organizations/${ORG_BETA}/vaults/${ALPHA_VAULT_IDS[0]}`)
      .set('Authorization', bearer('dave'))
      .send({ amount: '9999' })
    expect(res.status).toBe(404)
    const vault = testVaults.find((v) => v.id === ALPHA_VAULT_IDS[0])
    expect(vault?.amount).toBe('1000')
  })

  it('org-beta user cannot cancel org-alpha vault by ID → 404', async () => {
    const res = await request(app)
      .post(`/api/organizations/${ORG_BETA}/vaults/${ALPHA_VAULT_IDS[0]}/cancel`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(404)
    const vault = testVaults.find((v) => v.id === ALPHA_VAULT_IDS[0])
    expect(vault?.status).toBe('active')
  })

  it('org-beta user cannot get timeline of org-alpha vault → 404', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults/${ALPHA_VAULT_IDS[0]}/timeline`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(404)
  })

  it('org-alpha user can access their own vault by ID → 200', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults/${ALPHA_VAULT_IDS[0]}`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(ALPHA_VAULT_IDS[0])
  })
})

// =====================================================================
//  2. Milestone IDOR Tests
// =====================================================================
describe('Milestone IDOR Tests', () => {
  it('org-beta user cannot list milestones from org-alpha vault → 404', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults/${ALPHA_VAULT_IDS[0]}/milestones`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(404)
  })

  it('org-beta user cannot read milestone from org-alpha vault → 404', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults/${ALPHA_VAULT_IDS[0]}/milestones/${ALPHA_MILESTONE_IDS[0]}`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(404)
  })

  it('org-alpha user can access milestones from their own vault → 200', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults/${ALPHA_VAULT_IDS[0]}/milestones`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.milestones).toHaveLength(2)
  })
})

// =====================================================================
//  3. Saved Search IDOR Tests
// =====================================================================
describe('Saved Search IDOR Tests', () => {
  it('org-beta user cannot read org-alpha saved search → 404', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vault-searches/${ALPHA_SEARCH_ID}`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(404)
  })

  it('org-beta user cannot delete org-alpha saved search → 404', async () => {
    const res = await request(app)
      .delete(`/api/organizations/${ORG_BETA}/vault-searches/${ALPHA_SEARCH_ID}`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(404)
    const search = testSavedSearches.find((s) => s.id === ALPHA_SEARCH_ID)
    expect(search).toBeTruthy()
  })

  it('org-alpha user can read their own saved search → 200', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vault-searches/${ALPHA_SEARCH_ID}`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.search.id).toBe(ALPHA_SEARCH_ID)
  })
})

// =====================================================================
//  4. Vault Search Isolation
// =====================================================================
describe('Vault Search Isolation', () => {
  it('org-alpha search does not return org-beta vaults', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults/search`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((v: any) => v.id)
    BETA_VAULT_IDS.forEach(id => expect(ids).not.toContain(id))
  })

  it('org-beta search does not return org-alpha vaults', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults/search`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((v: any) => v.id)
    ALPHA_VAULT_IDS.forEach(id => expect(ids).not.toContain(id))
  })
})

// =====================================================================
//  5. Dual Membership User Isolation
// =====================================================================
describe('Dual Membership User (Frank)', () => {
  it('frank accessing alpha org sees only alpha vaults', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults`)
      .set('Authorization', bearer('frank'))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((v: any) => v.id)
    expect(ids.sort()).toEqual(ALPHA_VAULT_IDS.sort())
    BETA_VAULT_IDS.forEach(id => expect(ids).not.toContain(id))
  })

  it('frank accessing beta org sees only beta vaults', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults`)
      .set('Authorization', bearer('frank'))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((v: any) => v.id)
    expect(ids.sort()).toEqual(BETA_VAULT_IDS.sort())
    ALPHA_VAULT_IDS.forEach(id => expect(ids).not.toContain(id))
  })

  it('frank cannot read alpha vault via beta org route → 404', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_BETA}/vaults/${ALPHA_VAULT_IDS[0]}`)
      .set('Authorization', bearer('frank'))
    expect(res.status).toBe(404)
  })
})

// =====================================================================
//  6. Non-existent vs Forbidden Disambiguation
// =====================================================================
describe('Non-existent vs Forbidden Disambiguation', () => {
  it('returns 404 for non-existent vault ID', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults/non-existent-vault`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(404)
  })

  it('returns 403 for accessing org you are not a member of', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/vaults`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(403)
  })
})

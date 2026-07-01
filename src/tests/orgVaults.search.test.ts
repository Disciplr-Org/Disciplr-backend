/**
 * Tests for GET /api/orgs/:orgId/vaults/search
 *
 * Pattern mirrors orgVaults.test.ts / orgVaultIsolation.test.ts:
 *  - Build a self-contained Express app with inline handlers (no real DB).
 *  - Mock `authenticate` to avoid JWT session DB lookups.
 *  - Use the real `requireOrgAccess` + `queryParser` middleware.
 *  - The handler reproduces the search logic operating on an in-memory vault array
 *    so every route code path is exercised without a Postgres connection.
 *
 * Covers: auth, tenant isolation, full-text filter, status/verifier/capital/date
 * filters, combined filters, cursor pagination, injection safety, empty results.
 */

import request from 'supertest'
import express, { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { queryParser } from '../middleware/queryParser.js'
import { encodeCursor, decodeCursor } from '../utils/pagination.js'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'

// ── In-memory vault store ─────────────────────────────────────────────────────
interface SearchVault {
  id: string
  creator: string
  verifier: string
  amount: string
  status: 'draft' | 'active' | 'completed' | 'failed' | 'cancelled'
  organization_id: string
  start_date: string
  end_date: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

let testVaults: SearchVault[] = []
const setTestVaults = (v: SearchVault[]) => { testVaults = v }

// ── Mock authenticate (no session/DB dependency) ──────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

function mockAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' })
    return
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET) as any
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// ── Inline search handler (mirrors orgVaults.ts search logic on in-memory data)
function searchHandler(req: Request, res: Response): void {
  const { orgId } = req.params

  // Sanitise q the same way the real handler does
  const rawQ = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  const q = rawQ.replace(/[^\w\s.\-]/g, '').substring(0, 200)

  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'))))
  const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined

  // Base: org-scoped, not soft-deleted
  let results = testVaults.filter(
    v => v.organization_id === orgId && v.deleted_at === null,
  )

  // Full-text: simple substring match on creator + verifier (mirrors ILIKE fallback)
  if (q) {
    const lower = q.toLowerCase()
    results = results.filter(
      v => v.creator.toLowerCase().includes(lower) ||
           v.verifier.toLowerCase().includes(lower),
    )
  }

  // Structured filters
  const f = req.filters ?? {}

  if (f.status) {
    const s = Array.isArray(f.status) ? f.status[0] : f.status
    results = results.filter(v => v.status === s)
  }
  if (f.verifier) {
    const addr = Array.isArray(f.verifier) ? f.verifier[0] : f.verifier
    results = results.filter(v => v.verifier === addr)
  }
  if (f.amount_min) {
    const min = parseFloat(Array.isArray(f.amount_min) ? f.amount_min[0] : f.amount_min)
    results = results.filter(v => parseFloat(v.amount) >= min)
  }
  if (f.amount_max) {
    const max = parseFloat(Array.isArray(f.amount_max) ? f.amount_max[0] : f.amount_max)
    results = results.filter(v => parseFloat(v.amount) <= max)
  }
  if (f.date_from) {
    const from = new Date(Array.isArray(f.date_from) ? f.date_from[0] : f.date_from)
    results = results.filter(v => new Date(v.created_at) >= from)
  }
  if (f.date_to) {
    const to = new Date(Array.isArray(f.date_to) ? f.date_to[0] : f.date_to)
    results = results.filter(v => new Date(v.created_at) <= to)
  }

  // Stable sort: created_at DESC, id DESC
  results.sort((a, b) => {
    const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    return diff !== 0 ? diff : b.id.localeCompare(a.id)
  })

  // Cursor
  if (rawCursor) {
    try {
      const { timestamp, id } = decodeCursor(rawCursor)
      results = results.filter(v => {
        const t = new Date(v.created_at).getTime()
        const pivot = timestamp.getTime()
        return t < pivot || (t === pivot && v.id < id)
      })
    } catch {
      res.status(400).json({ error: 'Invalid cursor' })
      return
    }
  }

  // Limit + 1 trick
  const page = results.slice(0, limit + 1)
  const hasMore = page.length > limit
  const data = page.slice(0, limit)

  let nextCursor: string | undefined
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1]
    nextCursor = encodeCursor(new Date(last.created_at), last.id)
  }

  res.json({
    data,
    pagination: { limit, cursor: rawCursor, next_cursor: nextCursor, has_more: hasMore, count: data.length },
  })
}

// ── Test app ──────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

app.get(
  '/api/orgs/:orgId/vaults/search',
  mockAuthenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  queryParser({
    allowedSortFields: ['created_at', 'amount', 'end_date', 'status'],
    allowedFilterFields: ['status', 'verifier', 'amount_min', 'amount_max', 'date_from', 'date_to'],
  }),
  searchHandler,
)

// ── Token helper ──────────────────────────────────────────────────────────────
const bearer = (sub: string, role = UserRole.USER) =>
  `Bearer ${jwt.sign({ sub, userId: sub, role }, JWT_SECRET, { expiresIn: '1h' })}`

// ── Org / member fixtures ─────────────────────────────────────────────────────
const ORG_A = 'org-alpha'
const ORG_B = 'org-beta'

function seedOrgs() {
  setOrganizations([
    { id: ORG_A, name: 'Alpha Org', createdAt: '2025-01-01T00:00:00Z' },
    { id: ORG_B, name: 'Beta Org',  createdAt: '2025-01-01T00:00:00Z' },
  ])
  setOrgMembers([
    { orgId: ORG_A, userId: 'alice', role: 'owner'  },
    { orgId: ORG_A, userId: 'bob',   role: 'admin'  },
    { orgId: ORG_A, userId: 'carol', role: 'member' },
    { orgId: ORG_B, userId: 'dave',  role: 'owner'  },
  ])
}

// ── Vault fixtures ────────────────────────────────────────────────────────────
function mkVault(o: Partial<SearchVault> = {}): SearchVault {
  return {
    id: 'v-' + Math.random().toString(36).slice(2),
    creator: 'GCREATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    verifier: 'GVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    amount: '1000', status: 'active', organization_id: ORG_A,
    start_date: '2025-01-01T00:00:00Z', end_date: '2025-12-31T00:00:00Z',
    created_at: '2025-03-01T12:00:00Z', updated_at: '2025-03-01T12:00:00Z',
    deleted_at: null, ...o,
  }
}

const VA = mkVault({ id: 'v1', creator: 'alice-addr', amount: '1000', status: 'active',    organization_id: ORG_A, created_at: '2025-03-01T12:00:00Z' })
const VB = mkVault({ id: 'v2', creator: 'alice-addr', amount: '2000', status: 'completed', organization_id: ORG_A, created_at: '2025-02-01T12:00:00Z' })
const VC = mkVault({ id: 'v3', creator: 'bob-addr',   amount: '500',  status: 'failed',    organization_id: ORG_A, created_at: '2025-01-15T12:00:00Z' })
const VD = mkVault({ id: 'v4', creator: 'bob-addr',   amount: '1500', status: 'completed', organization_id: ORG_A, created_at: '2025-01-10T12:00:00Z' })
const VE = mkVault({ id: 'v5', creator: 'dave-addr',  amount: '3000', status: 'active',    organization_id: ORG_B, created_at: '2025-03-05T12:00:00Z' })
const ORG_A_VAULTS = [VA, VB, VC, VD]

// ── Setup / Teardown ──────────────────────────────────────────────────────────
beforeEach(() => {
  setTestVaults([...ORG_A_VAULTS])
  seedOrgs()
})

afterEach(() => {
  setTestVaults([])
  setOrganizations([])
  setOrgMembers([])
})

// ── Auth & Tenant Isolation ───────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — auth & isolation', () => {
  it('returns 401 when no Authorization header is sent', async () => {
    const res = await request(app).get(`/api/orgs/${ORG_A}/vaults/search`)
    expect(res.status).toBe(401)
  })

  it('returns 401 for a malformed bearer token', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', 'Bearer not.a.jwt')
    expect(res.status).toBe(401)
  })

  it('returns 403 when the caller is not a member of the org', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('dave'))   // dave is in ORG_B only
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not a member/)
  })

  it('returns 404 for a non-existent org', async () => {
    const res = await request(app)
      .get('/api/orgs/org-nope/vaults/search')
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/)
  })

  it('allows a member (carol) to search', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('carol'))
    expect(res.status).toBe(200)
    expect(res.body.data).toBeDefined()
  })

  it('admin (bob) can also search', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('bob'))
    expect(res.status).toBe(200)
  })

  it('cross-org: org-B member (dave) cannot search org-A vaults → 403', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('dave'))
    expect(res.status).toBe(403)
  })

  it('does not expose org-B vaults when they share the store', async () => {
    setTestVaults([...ORG_A_VAULTS, VE])
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data.map((v: any) => v.id)).not.toContain('v5')
  })
})

// ── Response shape ────────────────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — response shape', () => {
  it('returns data array and pagination object', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.pagination).toMatchObject({
      limit: expect.any(Number),
      has_more: expect.any(Boolean),
      count: expect.any(Number),
    })
  })

  it('returns all org-A vaults when no filters are applied', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(4)  // VA, VB, VC, VD
  })

  it('returns an empty data array when no vaults match', async () => {
    setTestVaults([])
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=nomatch`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
    expect(res.body.pagination.has_more).toBe(false)
  })

  it('soft-deleted vaults are excluded', async () => {
    setTestVaults([{ ...VA, deleted_at: '2025-04-01T00:00:00Z' }, VB])
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe('v2')
  })
})

// ── Full-text search ──────────────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — ?q= text matching', () => {
  it('q matching creator field returns relevant vaults', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=alice`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)           // VA and VB
    for (const v of res.body.data) expect(v.creator).toContain('alice')
  })

  it('q matching verifier field returns relevant vaults', async () => {
    const specialVerifier = 'GSPECIALVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    setTestVaults([
      mkVault({ id: 'vs1', verifier: specialVerifier, organization_id: ORG_A }),
      VA,
    ])
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=GSPECIAL`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe('vs1')
  })

  it('q with no match returns empty array', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=zzz-no-match-zzz`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('handles multi-word queries without error', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=alice+addr`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
  })

  it('empty q returns all vaults (no text filter applied)', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(4)
  })

  it('strips SQL injection chars from q — no 500', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=${encodeURIComponent("'; DROP TABLE vaults; --")}`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('data')
  })

  it('strips ILIKE wildcard chars from q — no 500', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=${encodeURIComponent('%admin%')}`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('data')
  })

  it('handles a null byte in q gracefully', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=${encodeURIComponent('\0evil')}`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
  })

  it('truncates extremely long q to 200 chars without error', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=${'a'.repeat(500)}`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
  })
})

// ── Status filter ─────────────────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — ?status= filter', () => {
  it('status=active returns only active vaults', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?status=active`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)   // only VA
    expect(res.body.data[0].status).toBe('active')
  })

  it('status=completed returns only completed vaults', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?status=completed`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)   // VB and VD
    for (const v of res.body.data) expect(v.status).toBe('completed')
  })

  it('status=failed returns only failed vaults', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?status=failed`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)   // only VC
    expect(res.body.data[0].id).toBe('v3')
  })

  it('status with no matching vaults returns empty array', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?status=cancelled`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })
})

// ── Verifier filter ───────────────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — ?verifier= filter', () => {
  it('exact verifier match returns correct vault', async () => {
    const addr = 'GSPECIFICVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    setTestVaults([
      mkVault({ id: 'v-ver', verifier: addr, organization_id: ORG_A }),
      VA,
    ])
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?verifier=${addr}`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].verifier).toBe(addr)
  })

  it('verifier not present in org returns empty array', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?verifier=GNOSUCHWVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })
})

// ── Capital range filters ─────────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — amount_min / amount_max', () => {
  it('amount_min=1500 excludes vaults below 1500', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?amount_min=1500`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    // VB (2000) and VD (1500) pass; VA (1000) and VC (500) don't
    expect(res.body.data).toHaveLength(2)
    for (const v of res.body.data) expect(parseFloat(v.amount)).toBeGreaterThanOrEqual(1500)
  })

  it('amount_max=1000 excludes vaults above 1000', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?amount_max=1000`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    // VA (1000) and VC (500) pass; VB (2000) and VD (1500) don't
    expect(res.body.data).toHaveLength(2)
    for (const v of res.body.data) expect(parseFloat(v.amount)).toBeLessThanOrEqual(1000)
  })

  it('amount_min=500 and amount_max=1000 returns only matching range', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?amount_min=500&amount_max=1000`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    // VA (1000) and VC (500) pass
    expect(res.body.data).toHaveLength(2)
    for (const v of res.body.data) {
      const amt = parseFloat(v.amount)
      expect(amt).toBeGreaterThanOrEqual(500)
      expect(amt).toBeLessThanOrEqual(1000)
    }
  })
})

// ── Date range filters ────────────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — date_from / date_to', () => {
  it('date_from=2025-02-01 excludes older vaults', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?date_from=2025-02-01T00:00:00Z`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    // VA (Mar) and VB (Feb) pass; VC (Jan-15) and VD (Jan-10) don't
    expect(res.body.data).toHaveLength(2)
    for (const v of res.body.data) {
      expect(new Date(v.created_at).getTime()).toBeGreaterThanOrEqual(new Date('2025-02-01T00:00:00Z').getTime())
    }
  })

  it('date_to=2025-01-31 excludes newer vaults', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?date_to=2025-01-31T23:59:59Z`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    // VC (Jan-15) and VD (Jan-10) pass; VA and VB don't
    expect(res.body.data).toHaveLength(2)
  })

  it('date_from + date_to returns only matching window', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?date_from=2025-01-01T00:00:00Z&date_to=2025-01-31T23:59:59Z`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)  // VC and VD
  })
})

// ── Combined filters ──────────────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — combined filters', () => {
  it('q=alice + status=active returns only alice\'s active vault', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=alice&status=active`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe('v1')
  })

  it('q=alice + status=completed returns alice\'s completed vault', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=alice&status=completed`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe('v2')
  })

  it('status=completed + amount_min=2000 returns only VB', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?status=completed&amount_min=2000`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe('v2')
  })

  it('q + date range with no matches returns empty array', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=alice&date_from=2025-01-01T00:00:00Z&date_to=2025-01-31T23:59:59Z`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    // alice-addr vaults are all in Feb or Mar — none in Jan
    expect(res.body.data).toHaveLength(0)
  })

  it('all filters combined — zero matches', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?q=nobody&status=cancelled&amount_min=9999`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })
})

// ── Cursor pagination ─────────────────────────────────────────────────────────
describe('GET /api/orgs/:orgId/vaults/search — cursor pagination', () => {
  it('respects the limit param', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?limit=2`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.pagination.limit).toBe(2)
    expect(res.body.data).toHaveLength(2)
  })

  it('clamps limit to 100 max', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?limit=999`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.pagination.limit).toBeLessThanOrEqual(100)
  })

  it('limit=1 returns only one result', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?limit=1`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('returns 400 for an invalid cursor', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?cursor=not-a-valid-cursor`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cursor/i)
  })

  it('accepts a valid encoded cursor without error', async () => {
    const validCursor = encodeCursor(new Date('2025-03-01T12:00:00Z'), 'v1')
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?cursor=${encodeURIComponent(validCursor)}`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
  })

  it('has_more=true and next_cursor present when total > limit', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?limit=2`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    // 4 vaults, limit=2 → 3 fetched internally, has_more=true
    expect(res.body.pagination.has_more).toBe(true)
    expect(typeof res.body.pagination.next_cursor).toBe('string')
    expect(() => decodeCursor(res.body.pagination.next_cursor)).not.toThrow()
  })

  it('has_more=false and no next_cursor when all fit in one page', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?limit=20`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    expect(res.body.pagination.has_more).toBe(false)
    expect(res.body.pagination.next_cursor).toBeUndefined()
  })

  it('paging with cursor yields non-overlapping pages', async () => {
    // Page 1: limit=2, get first 2 items
    const page1 = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?limit=2`)
      .set('Authorization', bearer('alice'))
    expect(page1.status).toBe(200)
    expect(page1.body.pagination.has_more).toBe(true)
    const cursor = page1.body.pagination.next_cursor

    // Page 2: use cursor, expect remaining items
    const page2 = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search?limit=2&cursor=${encodeURIComponent(cursor)}`)
      .set('Authorization', bearer('alice'))
    expect(page2.status).toBe(200)
    expect(page2.body.data.length).toBeGreaterThanOrEqual(1)

    // No id overlap between pages
    const ids1 = page1.body.data.map((v: any) => v.id)
    const ids2 = page2.body.data.map((v: any) => v.id)
    for (const id of ids2) expect(ids1).not.toContain(id)
  })

  it('all pages together contain every org-A vault exactly once', async () => {
    const allIds: string[] = []
    let cursor: string | undefined

    // Collect all pages with limit=2
    for (let i = 0; i < 10; i++) {
      const url = cursor
        ? `/api/orgs/${ORG_A}/vaults/search?limit=2&cursor=${encodeURIComponent(cursor)}`
        : `/api/orgs/${ORG_A}/vaults/search?limit=2`
      const res = await request(app).get(url).set('Authorization', bearer('alice'))
      expect(res.status).toBe(200)
      allIds.push(...res.body.data.map((v: any) => v.id))
      if (!res.body.pagination.has_more) break
      cursor = res.body.pagination.next_cursor
    }

    expect(allIds.sort()).toEqual(['v1', 'v2', 'v3', 'v4'].sort())
  })

  it('results are sorted created_at DESC', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vaults/search`)
      .set('Authorization', bearer('alice'))
    expect(res.status).toBe(200)
    const dates = res.body.data.map((v: any) => new Date(v.created_at).getTime())
    for (let i = 1; i < dates.length; i++) expect(dates[i]).toBeLessThanOrEqual(dates[i - 1])
  })
})

import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import {
  validateAndSanitizeQueryDefinition,
  hashResultSet,
  MAX_SEARCHES_PER_ORG,
  MIN_ALERT_FREQUENCY_MS,
} from '../routes/orgVaults.js'
import request from 'supertest'
import express, { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'

// ─── Validation unit tests ────────────────────────────────────────────────────

describe('validateAndSanitizeQueryDefinition', () => {
  it('accepts an empty object (no filters)', () => {
    const result = validateAndSanitizeQueryDefinition({})
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.sanitized).toEqual({})
  })

  it('accepts a valid full query definition', () => {
    const result = validateAndSanitizeQueryDefinition({
      q: 'active vault',
      status: 'active',
      verifier: 'GXXXX',
      amount_min: '100',
      amount_max: '5000.50',
      date_from: '2025-01-01',
      date_to: '2025-12-31',
      sort_by: 'created_at',
      sort_order: 'asc',
      limit: 50,
    })
    expect(result.valid).toBe(true)
    expect(result.sanitized.status).toBe('active')
    expect(result.sanitized.sort_order).toBe('asc')
    expect(result.sanitized.limit).toBe(50)
  })

  it('rejects invalid status values', () => {
    const result = validateAndSanitizeQueryDefinition({ status: 'deleted' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('status'))).toBe(true)
  })

  it('rejects non-numeric amount values', () => {
    const result = validateAndSanitizeQueryDefinition({ amount_min: 'abc' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('amount_min'))).toBe(true)
  })

  it('rejects amount_min with negative sign', () => {
    const result = validateAndSanitizeQueryDefinition({ amount_min: '-50' })
    expect(result.valid).toBe(false)
  })

  it('rejects invalid date_from string', () => {
    const result = validateAndSanitizeQueryDefinition({ date_from: 'not-a-date' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('date_from'))).toBe(true)
  })

  it('rejects unknown sort_by fields', () => {
    const result = validateAndSanitizeQueryDefinition({ sort_by: 'secret_column; DROP TABLE vaults;' })
    expect(result.valid).toBe(false)
  })

  it('rejects sort_order values other than asc/desc', () => {
    const result = validateAndSanitizeQueryDefinition({ sort_order: 'random' })
    expect(result.valid).toBe(false)
  })

  it('rejects limit below 1', () => {
    const result = validateAndSanitizeQueryDefinition({ limit: 0 })
    expect(result.valid).toBe(false)
  })

  it('rejects limit above 100', () => {
    const result = validateAndSanitizeQueryDefinition({ limit: 101 })
    expect(result.valid).toBe(false)
  })

  it('strips SQL injection characters from q', () => {
    const result = validateAndSanitizeQueryDefinition({ q: "'; DROP TABLE vaults; --" })
    expect(result.valid).toBe(true)
    expect(result.sanitized.q).not.toContain("'")
    expect(result.sanitized.q).not.toContain(';')
  })

  it('truncates q to 200 chars', () => {
    const result = validateAndSanitizeQueryDefinition({ q: 'a'.repeat(300) })
    expect(result.valid).toBe(true)
    expect(result.sanitized.q!.length).toBeLessThanOrEqual(200)
  })

  it('rejects non-object input', () => {
    expect(validateAndSanitizeQueryDefinition(null).valid).toBe(false)
    expect(validateAndSanitizeQueryDefinition('string').valid).toBe(false)
    expect(validateAndSanitizeQueryDefinition([]).valid).toBe(false)
  })

  it('collects all errors in a single pass', () => {
    const result = validateAndSanitizeQueryDefinition({
      status: 'bad',
      sort_order: 'sideways',
      limit: 9999,
    })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})

// ─── hashResultSet ────────────────────────────────────────────────────────────

describe('hashResultSet', () => {
  it('produces a 64-char hex string', () => {
    expect(hashResultSet(['a', 'b'])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    const ids = ['id-1', 'id-2', 'id-3']
    expect(hashResultSet(ids)).toBe(hashResultSet(ids))
  })

  it('differs when order changes', () => {
    expect(hashResultSet(['a', 'b'])).not.toBe(hashResultSet(['b', 'a']))
  })

  it('returns empty-array hash for empty input', () => {
    expect(hashResultSet([])).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ─── HTTP integration tests ───────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

function makeToken(userId: string, orgId?: string) {
  return jwt.sign({ userId, orgId }, JWT_SECRET)
}

function mockAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET) as any
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// In-memory saved-search store for integration tests
interface MockSearch {
  id: string
  org_id: string
  name: string
  query_definition: object
  alerts_enabled: boolean
  alert_recipient: string | null
  alert_frequency_ms: number
  last_evaluated_at: string | null
  last_result_hash: string | null
  created_by: string
  created_at: string
  updated_at: string
}

let mockSearchStore: MockSearch[] = []
let mockIdCounter = 0

const resetStore = () => {
  mockSearchStore = []
  mockIdCounter = 0
}

// Build a self-contained express app that mirrors the real route logic but uses
// the in-memory store so no database is required.
function buildApp() {
  const app = express()
  app.use(express.json())

  // POST /:orgId/vault-searches
  app.post(
    '/api/orgs/:orgId/vault-searches',
    mockAuthenticate,
    requireOrgAccess('owner', 'admin'),
    (req: Request, res: Response): void => {
      const { orgId } = req.params
      const userId: string = (req.user as any)?.userId ?? ''
      const { name, query_definition, alerts_enabled, alert_recipient, alert_frequency_ms } = req.body

      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
        res.status(400).json({ error: 'name must be a non-empty string (max 255 chars)' })
        return
      }

      const validation = validateAndSanitizeQueryDefinition(query_definition)
      if (!validation.valid) {
        res.status(400).json({ error: 'Invalid query_definition', details: validation.errors })
        return
      }

      const alertsOn = Boolean(alerts_enabled)
      if (alertsOn) {
        if (typeof alert_recipient !== 'string' || alert_recipient.trim().length === 0) {
          res.status(400).json({ error: 'alert_recipient is required when alerts_enabled is true' })
          return
        }
        const freqMs = alert_frequency_ms !== undefined ? Number(alert_frequency_ms) : MIN_ALERT_FREQUENCY_MS
        if (!Number.isInteger(freqMs) || freqMs < MIN_ALERT_FREQUENCY_MS) {
          res.status(400).json({ error: `alert_frequency_ms must be an integer >= ${MIN_ALERT_FREQUENCY_MS}` })
          return
        }
      }

      const orgSearches = mockSearchStore.filter((s) => s.org_id === orgId)
      if (orgSearches.length >= MAX_SEARCHES_PER_ORG) {
        res.status(422).json({ error: `Org has reached the maximum of ${MAX_SEARCHES_PER_ORG} saved searches` })
        return
      }

      const now = new Date().toISOString()
      const search: MockSearch = {
        id: `search-${++mockIdCounter}`,
        org_id: orgId,
        name: name.trim(),
        query_definition: validation.sanitized,
        alerts_enabled: alertsOn,
        alert_recipient: alertsOn ? (alert_recipient as string).trim() : null,
        alert_frequency_ms: alertsOn
          ? (alert_frequency_ms !== undefined ? Number(alert_frequency_ms) : MIN_ALERT_FREQUENCY_MS)
          : MIN_ALERT_FREQUENCY_MS,
        last_evaluated_at: null,
        last_result_hash: null,
        created_by: userId,
        created_at: now,
        updated_at: now,
      }
      mockSearchStore.push(search)
      res.status(201).json({ search })
    },
  )

  // GET /:orgId/vault-searches
  app.get(
    '/api/orgs/:orgId/vault-searches',
    mockAuthenticate,
    requireOrgAccess('owner', 'admin', 'member'),
    (req: Request, res: Response): void => {
      const { orgId } = req.params
      const searches = mockSearchStore.filter((s) => s.org_id === orgId)
      res.json({ searches })
    },
  )

  // GET /:orgId/vault-searches/:searchId
  app.get(
    '/api/orgs/:orgId/vault-searches/:searchId',
    mockAuthenticate,
    requireOrgAccess('owner', 'admin', 'member'),
    (req: Request, res: Response): void => {
      const { orgId, searchId } = req.params
      const search = mockSearchStore.find((s) => s.id === searchId && s.org_id === orgId)
      if (!search) {
        res.status(404).json({ error: 'Saved search not found' })
        return
      }
      res.json({ search })
    },
  )

  // DELETE /:orgId/vault-searches/:searchId
  app.delete(
    '/api/orgs/:orgId/vault-searches/:searchId',
    mockAuthenticate,
    requireOrgAccess('owner', 'admin'),
    (req: Request, res: Response): void => {
      const { orgId, searchId } = req.params
      const idx = mockSearchStore.findIndex((s) => s.id === searchId && s.org_id === orgId)
      if (idx === -1) {
        res.status(404).json({ error: 'Saved search not found' })
        return
      }
      mockSearchStore.splice(idx, 1)
      res.status(204).end()
    },
  )

  return app
}

const app = buildApp()

const ORG_A = 'org-alpha'
const ORG_B = 'org-beta'
const OWNER_A = 'owner-of-alpha'
const MEMBER_A = 'member-of-alpha'
const OWNER_B = 'owner-of-beta'

beforeEach(() => {
  resetStore()
  setOrganizations([
    { id: ORG_A, name: 'Alpha Corp', createdAt: new Date().toISOString() },
    { id: ORG_B, name: 'Beta Corp', createdAt: new Date().toISOString() },
  ])
  setOrgMembers([
    { orgId: ORG_A, userId: OWNER_A, role: 'owner' },
    { orgId: ORG_A, userId: MEMBER_A, role: 'member' },
    { orgId: ORG_B, userId: OWNER_B, role: 'owner' },
  ])
})

// ─── CRUD happy paths ─────────────────────────────────────────────────────────

describe('POST /api/orgs/:orgId/vault-searches', () => {
  it('creates a saved search and returns 201', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Active vaults', query_definition: { status: 'active' } })

    expect(res.status).toBe(201)
    expect(res.body.search.name).toBe('Active vaults')
    expect(res.body.search.org_id).toBe(ORG_A)
    expect(res.body.search.query_definition).toMatchObject({ status: 'active' })
    expect(res.body.search.alerts_enabled).toBe(false)
  })

  it('creates a search with alert subscription', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({
        name: 'Alert search',
        query_definition: { status: 'active' },
        alerts_enabled: true,
        alert_recipient: 'ops@example.com',
        alert_frequency_ms: MIN_ALERT_FREQUENCY_MS,
      })

    expect(res.status).toBe(201)
    expect(res.body.search.alerts_enabled).toBe(true)
    expect(res.body.search.alert_recipient).toBe('ops@example.com')
  })

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ query_definition: {} })

    expect(res.status).toBe(400)
  })

  it('returns 400 on invalid query_definition', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Bad query', query_definition: { status: 'nonexistent' } })

    expect(res.status).toBe(400)
    expect(res.body.details).toBeDefined()
  })

  it('returns 400 when alerts_enabled but no recipient', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Alert', query_definition: {}, alerts_enabled: true })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/alert_recipient/)
  })

  it('returns 400 when alert_frequency_ms is below the 1-hour floor', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({
        name: 'Too-fast alerts',
        query_definition: {},
        alerts_enabled: true,
        alert_recipient: 'x@y.com',
        alert_frequency_ms: 60_000, // 1 minute — below floor
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/alert_frequency_ms/)
  })

  it('returns 403 for a member (read-only role)', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(MEMBER_A)}`)
      .send({ name: 'Sneaky', query_definition: {} })

    expect(res.status).toBe(403)
  })

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .send({ name: 'No auth', query_definition: {} })

    expect(res.status).toBe(401)
  })
})

describe('GET /api/orgs/:orgId/vault-searches', () => {
  it('lists all searches for the org', async () => {
    await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'First', query_definition: {} })

    await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Second', query_definition: { status: 'active' } })

    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(MEMBER_A)}`)

    expect(res.status).toBe(200)
    expect(res.body.searches).toHaveLength(2)
  })

  it('returns an empty array when no searches exist', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)

    expect(res.status).toBe(200)
    expect(res.body.searches).toEqual([])
  })
})

describe('GET /api/orgs/:orgId/vault-searches/:searchId', () => {
  it('returns a single saved search', async () => {
    const createRes = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'My search', query_definition: { status: 'active' } })

    const searchId = createRes.body.search.id

    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vault-searches/${searchId}`)
      .set('Authorization', `Bearer ${makeToken(MEMBER_A)}`)

    expect(res.status).toBe(200)
    expect(res.body.search.id).toBe(searchId)
  })

  it('returns 404 for a non-existent search', async () => {
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vault-searches/does-not-exist`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)

    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/orgs/:orgId/vault-searches/:searchId', () => {
  it('deletes a search and returns 204', async () => {
    const createRes = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Delete me', query_definition: {} })

    const searchId = createRes.body.search.id

    const del = await request(app)
      .delete(`/api/orgs/${ORG_A}/vault-searches/${searchId}`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)

    expect(del.status).toBe(204)

    const get = await request(app)
      .get(`/api/orgs/${ORG_A}/vault-searches/${searchId}`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)

    expect(get.status).toBe(404)
  })

  it('returns 404 when the search does not exist', async () => {
    const res = await request(app)
      .delete(`/api/orgs/${ORG_A}/vault-searches/ghost`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)

    expect(res.status).toBe(404)
  })

  it('returns 403 for a member (read-only role)', async () => {
    const createRes = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Protected', query_definition: {} })

    const res = await request(app)
      .delete(`/api/orgs/${ORG_A}/vault-searches/${createRes.body.search.id}`)
      .set('Authorization', `Bearer ${makeToken(MEMBER_A)}`)

    expect(res.status).toBe(403)
  })
})

// ─── Cross-org isolation ──────────────────────────────────────────────────────

describe('cross-org isolation', () => {
  it('org B cannot read org A searches', async () => {
    await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Secret', query_definition: {} })

    // OWNER_B is not a member of ORG_A
    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_B)}`)

    expect(res.status).toBe(403)
  })

  it('list endpoint only returns searches for the requested org', async () => {
    await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Alpha search', query_definition: {} })

    await request(app)
      .post(`/api/orgs/${ORG_B}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_B)}`)
      .send({ name: 'Beta search', query_definition: {} })

    const res = await request(app)
      .get(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)

    expect(res.body.searches).toHaveLength(1)
    expect(res.body.searches[0].name).toBe('Alpha search')
  })

  it('org B cannot delete org A search by guessing the id', async () => {
    const createRes = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'Cross-org target', query_definition: {} })

    const searchId = createRes.body.search.id

    // OWNER_B is not in ORG_A — should 403
    const res = await request(app)
      .delete(`/api/orgs/${ORG_A}/vault-searches/${searchId}`)
      .set('Authorization', `Bearer ${makeToken(OWNER_B)}`)

    expect(res.status).toBe(403)
    // Search still exists
    expect(mockSearchStore.find((s) => s.id === searchId)).toBeDefined()
  })
})

// ─── Per-org cap ──────────────────────────────────────────────────────────────

describe('per-org cap', () => {
  it(`rejects the (${MAX_SEARCHES_PER_ORG + 1})th search with 422`, async () => {
    for (let i = 0; i < MAX_SEARCHES_PER_ORG; i++) {
      const res = await request(app)
        .post(`/api/orgs/${ORG_A}/vault-searches`)
        .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
        .send({ name: `Search ${i}`, query_definition: {} })
      expect(res.status).toBe(201)
    }

    const overflow = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({ name: 'One too many', query_definition: {} })

    expect(overflow.status).toBe(422)
    expect(overflow.body.error).toMatch(/maximum/)
  })

  it('cap is per-org — another org is not affected', async () => {
    for (let i = 0; i < MAX_SEARCHES_PER_ORG; i++) {
      await request(app)
        .post(`/api/orgs/${ORG_A}/vault-searches`)
        .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
        .send({ name: `Search ${i}`, query_definition: {} })
    }

    const res = await request(app)
      .post(`/api/orgs/${ORG_B}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_B)}`)
      .send({ name: 'Org B first', query_definition: {} })

    expect(res.status).toBe(201)
  })
})

// ─── Query injection prevention ───────────────────────────────────────────────

describe('query injection rejection', () => {
  it('strips injection chars from q field and still accepts the search', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({
        name: 'Injection attempt',
        query_definition: { q: "'; SELECT * FROM users; --" },
      })

    expect(res.status).toBe(201)
    const saved = res.body.search.query_definition as { q?: string }
    expect(saved.q).not.toContain("'")
    expect(saved.q).not.toContain(';')
  })

  it('rejects a sort_by field that is not whitelisted', async () => {
    const res = await request(app)
      .post(`/api/orgs/${ORG_A}/vault-searches`)
      .set('Authorization', `Bearer ${makeToken(OWNER_A)}`)
      .send({
        name: 'Injection sort',
        query_definition: { sort_by: '1; DROP TABLE vaults;' },
      })

    expect(res.status).toBe(400)
  })
})

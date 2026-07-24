/**
 * GraphQL org-scoped authorization tests.
 *
 * Strategy: build a thin Express app that prepends a context-injection
 * middleware before the graphqlRouter, bypassing real auth entirely for
 * positive cases, and verify that the resolvers themselves enforce org scope.
 *
 * Separate tests verify that the middleware (authenticate / requireOrgAccess)
 * rejects unauthenticated and non-member callers.
 *
 * Covers:
 *  - Unauthenticated request rejection (401)
 *  - Invalid token rejection (401)
 *  - Non-member request forbidden (403)
 *  - In-scope vault read returns data
 *  - Null for a non-existent vault id
 *  - Cross-org vault id argument is rejected (FORBIDDEN)
 *  - Vault with no orgId is rejected (FORBIDDEN)
 *  - vaults list scoped to calling org
 *  - vaults list for a second org returns only that org's vaults
 *  - Nested vault.validations are scoped to org vault ids
 *  - Nested milestone.validations are scoped to org vault ids
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = 'org-a'
const ORG_B = 'org-b'

const VAULT_A1 = {
  id: 'vault-a1', orgId: ORG_A, amount: '1000', status: 'active',
  milestones: [{ id: 'ms-a1', vaultId: 'vault-a1', title: 'M1', amount: '500' }],
}
const VAULT_B1 = { id: 'vault-b1', orgId: ORG_B, amount: '2000', status: 'active', milestones: [] }
const VAULT_NO_ORG = { id: 'vault-noorg', orgId: undefined, amount: '500', status: 'active', milestones: [] }
const ALL_VAULTS = [VAULT_A1, VAULT_B1, VAULT_NO_ORG]

const ALL_VERIFICATIONS = [
  { id: 'ver-1', targetId: 'vault-a1', verifierUserId: 'user-x', result: 'approved', evidenceHash: null, disputed: false, timestamp: '2024-01-01T00:00:00Z' },
  { id: 'ver-2', targetId: 'ms-a1',    verifierUserId: 'user-y', result: 'approved', evidenceHash: null, disputed: false, timestamp: '2024-01-02T00:00:00Z' },
  { id: 'ver-3', targetId: 'vault-b1', verifierUserId: 'user-z', result: 'rejected', evidenceHash: null, disputed: false, timestamp: '2024-01-03T00:00:00Z' },
]

// ---------------------------------------------------------------------------
// Mocks — registered before module import so ESM live bindings resolve to mocks
// ---------------------------------------------------------------------------

const mockListVaults = jest.fn<any>()
const mockGetVaultById = jest.fn<any>()

jest.unstable_mockModule('../services/vaultStore.js', () => ({
  listVaults: mockListVaults,
  getVaultById: mockGetVaultById,
}))

jest.unstable_mockModule('../services/analytics.service.js', () => ({
  getAnalyticsByPeriod: jest.fn<any>().mockResolvedValue({ totalVaults: 1, successRate: 1.0 }),
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  listVerifications: jest.fn<any>().mockResolvedValue(ALL_VERIFICATIONS),
}))

// Stub auth middleware — the middleware layer is tested in the negative-case
// app (see authApp below); the resolver-level tests use contextApp which
// injects req.user and req.orgId directly so the tests are hermetic.
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: jest.fn<any>((req: any, res: any, next: any) => {
    const auth: string | undefined = req.headers?.authorization
    if (!auth?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header' })
      return
    }
    const token = auth.slice(7)
    if (token === 'bad-token') {
      res.status(401).json({ error: 'Unauthorized: Invalid token' })
      return
    }
    req.user = { userId: token.startsWith('user:') ? token.slice(5) : token, role: 'member' }
    next()
  }),
}))

jest.unstable_mockModule('../middleware/orgAuth.js', () => ({
  requireOrgAccess: jest.fn<any>((..._roles: unknown[]) => (req: any, res: any, next: any) => {
    const orgId = req.params?.orgId
    const userId = req.user?.userId
    if (!orgId || !userId) {
      res.status(401).json({ error: 'Auth/Org info missing' })
      return
    }
    if (userId === 'non-member') {
      res.status(403).json({ error: 'Forbidden: not a member of this organization' })
      return
    }
    ;(req as any).orgId = orgId
    next()
  }),
}))

// ---------------------------------------------------------------------------
// Import graphqlRouter *after* mock registration
// ---------------------------------------------------------------------------

const { graphqlRouter } = await import('../routes/graphql.js')

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

/**
 * Standard app: authenticate + requireOrgAccess run normally (via mocks).
 * Use this for testing auth-layer rejections.
 */
const buildAuthApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/organizations/:orgId/graphql', graphqlRouter)
  return app
}

/**
 * Context-injected app: skips the middleware entirely and injects
 * req.user + req.orgId before graphqlRouter. Use this for testing
 * resolver-level enforcement.
 *
 * The graphqlRouter still enforces org scope inside the context function
 * and resolvers — what we're testing here.
 */
const buildContextApp = (orgId: string, userId = 'member-a') => {
  const app = express()
  app.use(express.json())
  app.use('/api/organizations/:orgId/graphql', (req: any, _res: any, next: any) => {
    req.user = { userId, role: 'member' }
    req.orgId = orgId
    next()
  }, graphqlRouter)
  return app
}

const gqlPost = (
  app: express.Application,
  orgId: string,
  query: string,
  token = 'user:member-a',
) =>
  request(app)
    .post(`/api/organizations/${orgId}/graphql`)
    .set('Authorization', `Bearer ${token}`)
    .send({ query })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphQL org-scoped authorization', () => {
  beforeEach(() => {
    mockListVaults.mockResolvedValue(ALL_VAULTS)
    mockGetVaultById.mockImplementation((id: string) =>
      Promise.resolve(ALL_VAULTS.find(v => v.id === id) ?? null),
    )
  })

  // --- Middleware layer: unauthenticated / non-member ---

  it('rejects requests without an Authorization header (401)', async () => {
    const app = buildAuthApp()
    const res = await request(app)
      .post(`/api/organizations/${ORG_A}/graphql`)
      .send({ query: '{ vaults { id } }' })
    expect(res.status).toBe(401)
  })

  it('rejects requests with an invalid token (401)', async () => {
    const app = buildAuthApp()
    const res = await request(app)
      .post(`/api/organizations/${ORG_A}/graphql`)
      .set('Authorization', 'Bearer bad-token')
      .send({ query: '{ vaults { id } }' })
    expect(res.status).toBe(401)
  })

  it('returns 403 when the user is not a member of the org', async () => {
    const app = buildAuthApp()
    const res = await gqlPost(app, ORG_A, '{ vaults { id } }', 'user:non-member')
    expect(res.status).toBe(403)
  })

  // --- Resolver-level enforcement (using context-injected app) ---

  it('returns an in-scope vault queried by id', async () => {
    const app = buildContextApp(ORG_A)
    const res = await gqlPost(app, ORG_A, '{ vault(id: "vault-a1") { id amount status } }')
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    expect(res.body.data.vault).toMatchObject({ id: 'vault-a1', amount: '1000', status: 'active' })
  })

  it('returns null for a vault id that does not exist', async () => {
    const app = buildContextApp(ORG_A)
    const res = await gqlPost(app, ORG_A, '{ vault(id: "no-such-vault") { id } }')
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    expect(res.body.data.vault).toBeNull()
  })

  it('rejects a vault id belonging to a different org with FORBIDDEN', async () => {
    const app = buildContextApp(ORG_A)
    const res = await gqlPost(app, ORG_A, '{ vault(id: "vault-b1") { id } }')
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeDefined()
    expect(res.body.errors[0].extensions?.code).toBe('FORBIDDEN')
    expect(res.body.data.vault).toBeNull()
  })

  it('rejects a vault with no orgId with FORBIDDEN', async () => {
    const app = buildContextApp(ORG_A)
    const res = await gqlPost(app, ORG_A, '{ vault(id: "vault-noorg") { id } }')
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeDefined()
    expect(res.body.errors[0].extensions?.code).toBe('FORBIDDEN')
  })

  it('vaults list includes only the calling org vaults', async () => {
    const app = buildContextApp(ORG_A)
    const res = await gqlPost(app, ORG_A, '{ vaults { id } }')
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    const ids: string[] = res.body.data.vaults.map((v: any) => v.id)
    expect(ids).toContain('vault-a1')
    expect(ids).not.toContain('vault-b1')
    expect(ids).not.toContain('vault-noorg')
  })

  it('vaults list for org-b returns only org-b vaults', async () => {
    const app = buildContextApp(ORG_B)
    const res = await gqlPost(app, ORG_B, '{ vaults { id } }')
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    const ids: string[] = res.body.data.vaults.map((v: any) => v.id)
    expect(ids).toContain('vault-b1')
    expect(ids).not.toContain('vault-a1')
  })

  it('nested vault.validations only surfaces verifications for org-scoped vault ids', async () => {
    const app = buildContextApp(ORG_A)
    const res = await gqlPost(app, ORG_A, `{
      vault(id: "vault-a1") {
        id
        validations { id targetId }
      }
    }`)
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    const verIds: string[] = res.body.data.vault.validations.map((v: any) => v.id)
    expect(verIds).toContain('ver-1')       // vault-a1 ∈ org-a ✓
    expect(verIds).not.toContain('ver-3')   // vault-b1 ∈ org-b ✗
  })

  it('nested milestone.validations are scoped to org vault ids', async () => {
    const app = buildContextApp(ORG_A)
    const res = await gqlPost(app, ORG_A, `{
      vault(id: "vault-a1") {
        milestones {
          id
          validations { id targetId }
        }
      }
    }`)
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    const milestones = res.body.data.vault.milestones
    expect(milestones).toHaveLength(1)
    const msVerIds: string[] = milestones[0].validations.map((v: any) => v.id)
    expect(msVerIds).toContain('ver-2')       // ms-a1 → vault-a1 ∈ org-a ✓
    expect(msVerIds).not.toContain('ver-3')   // vault-b1 ∈ org-b ✗
  })
})

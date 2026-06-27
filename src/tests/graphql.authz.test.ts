import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import express from 'express'
import request from 'supertest'

const mockVaults = [
  {
    id: 'vault-a',
    organizationId: 'org-a',
    amount: '1000',
    status: 'active',
    milestones: [
      {
        id: 'milestone-a',
        vaultId: 'vault-a',
        title: 'Org A milestone',
        amount: '1000',
      },
    ],
  },
  {
    id: 'vault-b',
    organizationId: 'org-b',
    amount: '2500',
    status: 'completed',
    milestones: [
      {
        id: 'milestone-b',
        vaultId: 'vault-b',
        title: 'Org B milestone',
        amount: '2500',
      },
    ],
  },
]

mock.module('../services/vaultStore.js', () => ({
  listVaults: mock(async () => mockVaults),
  getVaultById: mock(async (id: string) => mockVaults.find((vault) => vault.id === id) ?? null),
}))

mock.module('../services/verifiers.js', () => ({
  listVerifications: mock(async () => [
    {
      id: 'validation-a',
      targetId: 'milestone-a',
      verifierUserId: 'verifier-a',
      result: 'approved',
    },
    {
      id: 'validation-b',
      targetId: 'milestone-b',
      verifierUserId: 'verifier-b',
      result: 'approved',
    },
  ]),
}))

mock.module('../middleware/auth.js', () => ({
  authenticate: mock((req: any, res: any, next: any) => {
    if (!req.header('authorization')) {
      res.status(401).json({ error: 'Missing or malformed Authorization header' })
      return
    }
    req.user = { userId: 'user-a', role: 'member' }
    next()
  }),
}))

mock.module('../middleware/orgAuth.js', () => ({
  requireOrgRole: mock(() => (req: any, res: any, next: any) => {
    if (!req.params.orgId) {
      res.status(401).json({ error: 'Auth/Org info missing' })
      return
    }
    req.orgId = req.params.orgId
    req.orgRole = 'member'
    next()
  }),
}))

describe('GraphQL org authorization', () => {
  let app: express.Application

  beforeEach(async () => {
    const { graphqlRouter } = await import('../routes/graphql.js')
    app = express()
    app.use(express.json())
    app.use('/api/organizations/:orgId/graphql', graphqlRouter)
  })

  afterEach(() => {
    mock.restore()
  })

  it('returns an in-scope vault by id', async () => {
    const response = await request(app)
      .post('/api/organizations/org-a/graphql')
      .set('Authorization', 'Bearer test-token')
      .send({
        query: `
          query {
            vault(id: "vault-a") {
              id
              amount
              analytics {
                totalVaults
                activeVaults
              }
            }
          }
        `,
      })

    expect(response.status).toBe(200)
    expect(response.body.errors).toBeUndefined()
    expect(response.body.data.vault).toEqual({
      id: 'vault-a',
      amount: '1000',
      analytics: {
        totalVaults: 1,
        activeVaults: 1,
      },
    })
  })

  it('returns null for a cross-org vault id argument', async () => {
    const response = await request(app)
      .post('/api/organizations/org-a/graphql')
      .set('Authorization', 'Bearer test-token')
      .send({
        query: `
          query {
            vault(id: "vault-b") {
              id
              amount
            }
          }
        `,
      })

    expect(response.status).toBe(200)
    expect(response.body.errors).toBeUndefined()
    expect(response.body.data.vault).toBeNull()
  })

  it('filters vault lists to the route organization', async () => {
    const response = await request(app)
      .post('/api/organizations/org-a/graphql')
      .set('Authorization', 'Bearer test-token')
      .send({
        query: `
          query {
            vaults {
              id
              amount
            }
          }
        `,
      })

    expect(response.status).toBe(200)
    expect(response.body.errors).toBeUndefined()
    expect(response.body.data.vaults).toEqual([{ id: 'vault-a', amount: '1000' }])
  })

  it('does not expose nested validations from another org', async () => {
    const response = await request(app)
      .post('/api/organizations/org-a/graphql')
      .set('Authorization', 'Bearer test-token')
      .send({
        query: `
          query {
            vaults {
              id
              milestones {
                id
                validations {
                  id
                  targetId
                }
              }
            }
          }
        `,
      })

    expect(response.status).toBe(200)
    const serialized = JSON.stringify(response.body.data)
    expect(serialized).toContain('validation-a')
    expect(serialized).not.toContain('validation-b')
    expect(serialized).not.toContain('milestone-b')
  })

  it('rejects unauthenticated GraphQL requests', async () => {
    const response = await request(app)
      .post('/api/organizations/org-a/graphql')
      .send({ query: '{ vaults { id } }' })

    expect(response.status).toBe(401)
  })
})

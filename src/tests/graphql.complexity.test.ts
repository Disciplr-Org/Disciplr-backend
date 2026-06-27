import { beforeEach, describe, expect, it, mock } from 'bun:test'
import express from 'express'
import request from 'supertest'

mock.module('../services/vaultStore.js', () => ({
  listVaults: mock(async () => [
    {
      id: 'vault-1',
      amount: '1000',
      status: 'active',
      milestones: [
        {
          id: 'milestone-1',
          vaultId: 'vault-1',
          title: 'First Milestone',
          amount: '500',
        },
      ],
    },
  ]),
  getVaultById: mock(async () => ({
    id: 'vault-1',
    amount: '1000',
    status: 'active',
    milestones: [
      {
        id: 'milestone-1',
        vaultId: 'vault-1',
        title: 'First Milestone',
        amount: '500',
      },
    ],
  })),
}))

mock.module('../services/analytics.service.js', () => ({
  getAnalyticsByPeriod: mock(async () => ({
    totalVaults: 1,
    successRate: 1,
  })),
}))

mock.module('../services/verifiers.js', () => ({
  listVerifications: mock(async () => [
    {
      id: 'val-1',
      targetId: 'milestone-1',
      verifierUserId: 'user-1',
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
    req.user = { userId: 'test-user', role: 'member' }
    next()
  }),
}))

mock.module('../middleware/orgAuth.js', () => ({
  requireOrgRole: mock(() => (req: any, _res: any, next: any) => {
    req.orgId = req.params.orgId
    next()
  }),
}))

describe('GraphQL depth and complexity limits', () => {
  let app: express.Application

  beforeEach(async () => {
    const { graphqlRouter } = await import('../routes/graphql.js')
    app = express()
    app.use(express.json())
    app.use('/api/organizations/:orgId/graphql', graphqlRouter)
  })

  const postGraphQL = (query: string) =>
    request(app)
      .post('/api/organizations/org-1/graphql')
      .set('Authorization', 'Bearer test-token')
      .send({ query })

  it('allows a normal query within limits', async () => {
    const response = await postGraphQL(`
      query {
        vaults {
          id
          amount
        }
      }
    `)

    expect(response.status).toBe(200)
    expect(response.body.errors).toBeUndefined()
    expect(response.body.data.vaults).toEqual([{ id: 'vault-1', amount: '1000' }])
  })

  it('rejects queries exceeding the depth limit', async () => {
    const response = await postGraphQL(`
      query {
        vaults {
          analytics {
            totalVaults {
              too {
                deep {
                  here
                }
              }
            }
          }
        }
      }
    `)

    expect(response.status).toBe(200)
    expect(JSON.stringify(response.body.errors)).toContain('Query exceeds maximum depth of 5')
  })

  it('allows a broad query at the complexity boundary', async () => {
    const selections = Array.from({ length: 13 }, (_, index) => `v${index}: vaults { id amount }`).join('\n')
    const response = await postGraphQL(`query { ${selections} }`)

    expect(response.status).toBe(200)
    expect(response.body.errors).toBeUndefined()
    expect(response.body.data.v0).toEqual([{ id: 'vault-1', amount: '1000' }])
    expect(response.body.data.v12).toEqual([{ id: 'vault-1', amount: '1000' }])
  })

  it('rejects alias-heavy queries exceeding the complexity budget', async () => {
    const selections = Array.from({ length: 14 }, (_, index) => `v${index}: vaults { id amount }`).join('\n')
    const response = await postGraphQL(`query { ${selections} }`)

    expect(response.status).toBe(200)
    expect(JSON.stringify(response.body.errors)).toContain('Query exceeds maximum complexity of 40')
  })

  it('allows basic introspection fields', async () => {
    const response = await postGraphQL('{ __typename }')

    expect(response.status).toBe(200)
    expect(response.body.errors).toBeUndefined()
    expect(response.body.data.__typename).toBe('Query')
  })
})

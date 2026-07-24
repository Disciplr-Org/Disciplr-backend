/**
 * Regression test for GET /api/organizations/:orgId/vaults.
 *
 * The handler used to filter an in-memory array (`vaults` from routes/vaults.ts)
 * that is never populated outside of tests, so it silently returned an empty
 * list for every org in a real deployment. This test exercises the real
 * POST /api/vaults and GET /api/organizations/:orgId/vaults handlers end to
 * end against a real Postgres database, so a regression back to the
 * in-memory array would show up as a failing assertion here.
 *
 * DATABASE_URL must be set before `../routes/vaults.js` / `../routes/orgVaults.js`
 * are first imported, since their DB modules (`db/index.ts`, `db/knex.ts`)
 * read it at module-evaluation time. Both are therefore imported dynamically,
 * after the assignment below, rather than via static `import`.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/disciplr_test'

import request from 'supertest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals'
import { setupTestDatabase, teardownTestDatabase } from './helpers/testDatabase.js'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'
import { generateAccessToken } from '../lib/auth-utils.js'
import { UserRole } from '../types/user.js'

const { vaultsRouter } = await import('../routes/vaults.js')
const { orgVaultsRouter } = await import('../routes/orgVaults.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

const stellar = (): string => `G${'A'.repeat(55)}`

const validVaultPayload = (orgId: string) => ({
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: stellar(),
  destinations: { success: stellar(), failure: stellar() },
  milestones: [{ title: 'Kickoff', dueDate: '2030-02-01T00:00:00.000Z', amount: '1000' }],
  orgId,
})

describe('GET /api/organizations/:orgId/vaults (DB-backed listing)', () => {
  let db: Knex
  let app: express.Express

  const ORG_ID = randomUUID()
  const USER_ID = 'org-vault-owner'
  const token = generateAccessToken({ userId: USER_ID, role: UserRole.USER })

  beforeAll(async () => {
    db = await setupTestDatabase()

    app = express()
    app.use(express.json())
    app.use('/api/vaults', vaultsRouter)
    app.use('/api/organizations', orgVaultsRouter)
    app.use(errorHandler)
  })

  afterAll(async () => {
    await teardownTestDatabase(db)
  })

  beforeEach(async () => {
    await db('vaults').del()
    setOrganizations([{ id: ORG_ID, name: 'Integration Org', createdAt: new Date().toISOString() }])
    setOrgMembers([{ orgId: ORG_ID, userId: USER_ID, role: 'owner' }])
  })

  afterEach(() => {
    setOrganizations([])
    setOrgMembers([])
  })

  it('lists a vault created via POST /api/vaults', async () => {
    const createRes = await request(app)
      .post('/api/vaults')
      .set('Authorization', `Bearer ${token}`)
      .send(validVaultPayload(ORG_ID))

    expect(createRes.status).toBe(201)
    const vaultId = createRes.body.vault.id
    expect(vaultId).toBeDefined()

    const listRes = await request(app)
      .get(`/api/organizations/${ORG_ID}/vaults`)
      .set('Authorization', `Bearer ${token}`)

    expect(listRes.status).toBe(200)
    expect(listRes.body.pagination.total).toBe(1)

    const listedVault = listRes.body.data.find((v: { id: string }) => v.id === vaultId)
    expect(listedVault).toBeDefined()
    expect(listedVault.orgId).toBe(ORG_ID)
  })

  it('does not return vaults belonging to a different organization', async () => {
    const otherOrgId = randomUUID()

    await db('vaults').insert({
      id: randomUUID(),
      creator: stellar(),
      amount: '500',
      start_date: new Date('2030-01-01'),
      end_date: new Date('2030-06-01'),
      verifier: stellar(),
      success_destination: stellar(),
      failure_destination: stellar(),
      status: 'draft',
      organization_id: otherOrgId,
      late_check_in_window_secs: 0,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/vaults`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
    expect(res.body.pagination.total).toBe(0)
  })
})

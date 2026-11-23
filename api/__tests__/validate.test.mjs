import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../index.mjs'
import { truncateDb, buildVaultPayload, getTestPool, randomStellarAddress } from './helpers/db.mjs'

beforeEach(async () => {
  await truncateDb()
})

test('POST /vaults/:id/milestones/:mid/validate - validation failure cases (404, 403, 409)', async () => {
  const verifier = randomStellarAddress()
  const otherVerifier = randomStellarAddress()

  const createRes = await request(app).post('/api/vaults').send(buildVaultPayload({
    verifier,
    milestones: [
      { title: 'Task 1', amount: 500, dueDate: new Date(Date.now() + 86400000).toISOString() },
      { title: 'Task 2', amount: 500, dueDate: new Date(Date.now() + 2 * 86400000).toISOString() },
    ],
  }))
  assert.equal(createRes.status, 201)
  const vault = createRes.body.data
  const mid1 = vault.milestones[0].id

  // 404: Unknown vault
  const resUnknownVault = await request(app)
    .post('/api/vaults/vault-unknown/milestones/m1/validate')
    .send({ verifier })
  assert.equal(resUnknownVault.status, 404)
  assert.equal(resUnknownVault.body.error, 'Vault not found')

  // 404: Unknown milestone
  const resUnknownMilestone = await request(app)
    .post(`/api/vaults/${vault.id}/milestones/milestone-unknown/validate`)
    .send({ verifier })
  assert.equal(resUnknownMilestone.status, 404)
  assert.equal(resUnknownMilestone.body.error, 'Milestone not found')

  // 403: Wrong verifier
  const resWrongVerifier = await request(app)
    .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
    .send({ verifier: otherVerifier })
  assert.equal(resWrongVerifier.status, 403)
  assert.equal(resWrongVerifier.body.error, 'Only the vault verifier may validate milestones')

  // First validation succeeds
  const resVal1 = await request(app)
    .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
    .send({ verifier })
  assert.equal(resVal1.status, 200)

  // 409: Double validate
  const resDoubleValidate = await request(app)
    .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
    .send({ verifier })
  assert.equal(resDoubleValidate.status, 409)
  assert.equal(resDoubleValidate.body.error, 'Milestone already validated')
})

test('POST /vaults/:id/milestones/:mid/validate - validating last milestone completes vault and releases funds', async () => {
  const verifier = randomStellarAddress()

  const createRes = await request(app).post('/api/vaults').send(buildVaultPayload({
    verifier,
    milestones: [
      { title: 'Single Milestone', amount: 1000, dueDate: new Date(Date.now() + 86400000).toISOString() },
    ],
  }))
  assert.equal(createRes.status, 201)
  const vault = createRes.body.data
  const mid = vault.milestones[0].id

  const resVal = await request(app)
    .post(`/api/vaults/${vault.id}/milestones/${mid}/validate`)
    .send({ verifier })
  assert.equal(resVal.status, 200)
  assert.equal(resVal.body.data.status, 'completed')
  assert.equal(resVal.body.data.milestones[0].status, 'completed')

  // Assert direct DB state if Postgres is connected
  const pool = getTestPool()
  if (pool) {
    const { rows: vaultRows } = await pool.query('SELECT status FROM vaults WHERE id = $1', [vault.id])
    assert.equal(vaultRows[0].status, 'completed')

    const { rows: actRows } = await pool.query('SELECT type FROM activity_log WHERE vault_id = $1 ORDER BY created_at ASC', [vault.id])
    const types = actRows.map((r) => r.type)
    assert.ok(types.includes('validate'))
    assert.ok(types.includes('release'))
  }

  // Attempting to validate on completed vault returns 409
  const resPostComplete = await request(app)
    .post(`/api/vaults/${vault.id}/milestones/${mid}/validate`)
    .send({ verifier })
  assert.equal(resPostComplete.status, 409)
  assert.equal(resPostComplete.body.error, 'Vault is completed')
})

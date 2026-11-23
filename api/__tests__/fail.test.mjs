import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../index.mjs'
import { truncateDb, buildVaultPayload, getTestPool, randomStellarAddress } from './helpers/db.mjs'

beforeEach(async () => {
  await truncateDb()
})

test('POST /vaults/:id/fail - failure error handling (404, 403, 409)', async () => {
  const verifier = randomStellarAddress()
  const wrongVerifier = randomStellarAddress()

  const createRes = await request(app).post('/api/vaults').send(buildVaultPayload({ verifier }))
  assert.equal(createRes.status, 201)
  const vaultId = createRes.body.data.id

  // 404: Unknown vault
  const resUnknown = await request(app)
    .post('/api/vaults/vault-nonexistent/fail')
    .send({ verifier })
  assert.equal(resUnknown.status, 404)
  assert.equal(resUnknown.body.error, 'Vault not found')

  // 403: Wrong verifier
  const resWrong = await request(app)
    .post(`/api/vaults/${vaultId}/fail`)
    .send({ verifier: wrongVerifier })
  assert.equal(resWrong.status, 403)
  assert.equal(resWrong.body.error, 'Only the vault verifier may fail a vault')

  // First fail call succeeds
  const resFail = await request(app)
    .post(`/api/vaults/${vaultId}/fail`)
    .send({ verifier })
  assert.equal(resFail.status, 200)
  assert.equal(resFail.body.data.status, 'failed')

  // 409: Second fail call
  const resDoubleFail = await request(app)
    .post(`/api/vaults/${vaultId}/fail`)
    .send({ verifier })
  assert.equal(resDoubleFail.status, 409)
  assert.equal(resDoubleFail.body.error, 'Vault is failed')
})

test('POST /vaults/:id/fail - transitions vault, fails pending milestones only, and writes redirect', async () => {
  const verifier = randomStellarAddress()

  const createRes = await request(app).post('/api/vaults').send(buildVaultPayload({
    verifier,
    milestones: [
      { title: 'Step 1', amount: 500, dueDate: new Date(Date.now() + 86400000).toISOString() },
      { title: 'Step 2', amount: 500, dueDate: new Date(Date.now() + 2 * 86400000).toISOString() },
    ],
  }))
  assert.equal(createRes.status, 201)
  const vault = createRes.body.data
  const mid1 = vault.milestones[0].id

  // Validate milestone 1 first
  const valRes = await request(app)
    .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
    .send({ verifier })
  assert.equal(valRes.status, 200)

  // Fail the vault
  const failRes = await request(app)
    .post(`/api/vaults/${vault.id}/fail`)
    .send({ verifier })
  assert.equal(failRes.status, 200)
  const failedVault = failRes.body.data
  assert.equal(failedVault.status, 'failed')

  const m1 = failedVault.milestones.find((m) => m.id === mid1)
  const m2 = failedVault.milestones.find((m) => m.id !== mid1)
  assert.equal(m1.status, 'completed')
  assert.equal(m2.status, 'failed')

  // Assert direct DB state if Postgres is connected
  const pool = getTestPool()
  if (pool) {
    const { rows: vaultRows } = await pool.query('SELECT status FROM vaults WHERE id = $1', [vault.id])
    assert.equal(vaultRows[0].status, 'failed')

    const { rows: msRows } = await pool.query('SELECT id, status FROM milestones WHERE vault_id = $1', [vault.id])
    const dbM1 = msRows.find((r) => r.id === mid1)
    const dbM2 = msRows.find((r) => r.id !== mid1)
    assert.equal(dbM1.status, 'completed')
    assert.equal(dbM2.status, 'failed')

    const { rows: actRows } = await pool.query('SELECT type FROM activity_log WHERE vault_id = $1 AND type = $2', [vault.id, 'redirect'])
    assert.equal(actRows.length, 1)
  }
})

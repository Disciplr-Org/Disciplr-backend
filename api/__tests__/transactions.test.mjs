import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../index.mjs'
import { truncateDb, buildVaultPayload, randomStellarAddress } from './helpers/db.mjs'

beforeEach(async () => {
  await truncateDb()
})

test('GET /transactions - lists all activity and filters by vaultId', async () => {
  const verifier = randomStellarAddress()

  const v1 = await request(app).post('/api/vaults').send(buildVaultPayload({ verifier }))
  const v2 = await request(app).post('/api/vaults').send(buildVaultPayload({ verifier }))
  assert.equal(v1.status, 201)
  assert.equal(v2.status, 201)

  const vaultId1 = v1.body.data.id
  const vaultId2 = v2.body.data.id

  // All transactions
  const resAll = await request(app).get('/api/transactions')
  assert.equal(resAll.status, 200)
  assert.ok(Array.isArray(resAll.body.data))
  assert.ok(resAll.body.data.length >= 2)
  assert.equal(resAll.body.count, resAll.body.data.length)

  // Filtered by vaultId
  const resVault1 = await request(app).get(`/api/transactions?vaultId=${vaultId1}`)
  assert.equal(resVault1.status, 200)
  assert.ok(resVault1.body.data.length >= 1)
  assert.ok(resVault1.body.data.every((t) => t.vaultId === vaultId1))

  // Nonexistent vaultId returns empty array
  const resEmpty = await request(app).get('/api/transactions?vaultId=vault-none')
  assert.equal(resEmpty.status, 200)
  assert.equal(resEmpty.body.data.length, 0)
  assert.equal(resEmpty.body.count, 0)
})

import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../index.mjs'
import { truncateDb, buildVaultPayload, randomStellarAddress } from './helpers/db.mjs'

beforeEach(async () => {
  await truncateDb()
})

test('GET /stats - returns aggregate statistics with and without creator filter', async () => {
  const creatorA = randomStellarAddress()
  const creatorB = randomStellarAddress()
  const verifier = randomStellarAddress()

  // Create active vault for creatorA
  const v1 = await request(app).post('/api/vaults').send(buildVaultPayload({ creator: creatorA, verifier, amount: 1000 }))
  assert.equal(v1.status, 201)

  // Create completed vault for creatorA
  const v2 = await request(app).post('/api/vaults').send(buildVaultPayload({
    creator: creatorA,
    verifier,
    amount: 500,
    milestones: [{ title: 'Single', amount: 500, dueDate: new Date(Date.now() + 86400000).toISOString() }],
  }))
  assert.equal(v2.status, 201)
  const valRes = await request(app)
    .post(`/api/vaults/${v2.body.data.id}/milestones/${v2.body.data.milestones[0].id}/validate`)
    .send({ verifier })
  assert.equal(valRes.status, 200)

  // Create failed vault for creatorB
  const v3 = await request(app).post('/api/vaults').send(buildVaultPayload({
    creator: creatorB,
    verifier,
    amount: 300,
    milestones: [{ title: 'Single', amount: 300, dueDate: new Date(Date.now() + 86400000).toISOString() }],
  }))
  assert.equal(v3.status, 201)
  const failRes = await request(app)
    .post(`/api/vaults/${v3.body.data.id}/fail`)
    .send({ verifier })
  assert.equal(failRes.status, 200)

  // Overall stats
  const resAll = await request(app).get('/api/stats')
  assert.equal(resAll.status, 200)
  const statsAll = resAll.body.data
  assert.ok(statsAll.totalVaults >= 3)
  assert.ok(statsAll.active >= 1)
  assert.ok(statsAll.completed >= 1)
  assert.ok(statsAll.failed >= 1)
  assert.ok(Number(statsAll.totalLocked) >= 1000)
  assert.ok(Number(statsAll.totalReleased) >= 500)
  assert.ok(Number(statsAll.totalRedirected) >= 300)

  // Filtered by creatorA
  const resA = await request(app).get(`/api/stats?creator=${creatorA}`)
  assert.equal(resA.status, 200)
  const statsA = resA.body.data
  assert.equal(statsA.totalVaults, 2)
  assert.equal(statsA.active, 1)
  assert.equal(statsA.completed, 1)
  assert.equal(statsA.failed, 0)
  assert.equal(statsA.totalLocked, '1000')
  assert.equal(statsA.totalReleased, '500')
  assert.equal(statsA.totalRedirected, '0')
  assert.equal(statsA.successRate, 100)
})

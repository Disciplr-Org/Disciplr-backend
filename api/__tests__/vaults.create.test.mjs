import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { Keypair } from '@stellar/stellar-sdk'
import { createApp } from '../index.mjs'
import { MemoryStore } from '../../apilib/store.mjs'

function createTestApp() {
  const store = new MemoryStore()
  return createApp(async () => store)
}

function randomKey() {
  return Keypair.random().publicKey()
}

function corruptKey(key) {
  const pos = 15
  const flipped = key[pos] === 'A' ? 'B' : 'A'
  return key.slice(0, pos) + flipped + key.slice(pos + 1)
}

function validPayload(overrides = {}) {
  const creator = overrides.creator || randomKey()
  const verifier = overrides.verifier || randomKey()
  const now = Date.now()

  return {
    name: 'HTTP Test Vault',
    creator,
    verifier,
    amount: 1000,
    startDate: new Date(now + 60000).toISOString(),
    endDate: new Date(now + 30 * 86400000).toISOString(),
    successDestination: creator,
    failureDestination: randomKey(),
    milestones: [
      {
        title: 'Milestone 1',
        amount: 500,
        dueDate: new Date(now + 10 * 86400000).toISOString(),
      },
      {
        title: 'Milestone 2',
        amount: 500,
        dueDate: new Date(now + 20 * 86400000).toISOString(),
      },
    ],
    ...overrides,
  }
}

test('POST /vaults - happy path returns 201 with created vault data', async () => {
  const app = createTestApp()
  const payload = validPayload({ name: 'Happy Path Vault' })

  const res = await request(app)
    .post('/api/vaults')
    .send(payload)

  assert.equal(res.status, 201)
  assert.equal(typeof res.body, 'object')
  assert.ok(res.body.data)
  assert.equal(res.body.data.name, 'Happy Path Vault')
  assert.equal(res.body.data.creator, payload.creator)
  assert.equal(res.body.data.verifier, payload.verifier)
  assert.equal(res.body.data.status, 'active')
  assert.equal(res.body.data.milestones.length, 2)
  assert.equal(res.body.data.milestones[0].title, 'Milestone 1')
  assert.equal(res.body.data.milestones[1].title, 'Milestone 2')
})

test('POST /vaults - rejection 1: invalid stellar address checksum produces 400 with details shape', async () => {
  const app = createTestApp()
  const payload = validPayload()
  payload.creator = corruptKey(payload.creator)

  const res = await request(app)
    .post('/api/vaults')
    .send(payload)

  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'Validation failed')
  assert.ok(Array.isArray(res.body.details))
  const creatorIssue = res.body.details.find((d) => d.field === 'creator')
  assert.ok(creatorIssue, 'Must identify creator field')
  assert.equal(creatorIssue.code, 'invalid_address')
  assert.ok(typeof creatorIssue.message === 'string')
})

test('POST /vaults - rejection 2: creator === verifier produces 400 with details shape', async () => {
  const app = createTestApp()
  const sameKey = randomKey()
  const payload = validPayload({
    creator: sameKey,
    verifier: sameKey,
  })

  const res = await request(app)
    .post('/api/vaults')
    .send(payload)

  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'Validation failed')
  assert.ok(Array.isArray(res.body.details))
  const verifierIssue = res.body.details.find((d) => d.field === 'verifier')
  assert.ok(verifierIssue, 'Must reject verifier equal to creator')
  assert.equal(verifierIssue.code, 'invalid_role')
})

test('POST /vaults - rejection 3: unknown fields (strict) produces 400 with details shape', async () => {
  const app = createTestApp()
  const payload = validPayload({
    admin: true,
  })

  const res = await request(app)
    .post('/api/vaults')
    .send(payload)

  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'Validation failed')
  assert.ok(Array.isArray(res.body.details))
  const unknownIssue = res.body.details.find((d) => d.field === 'admin')
  assert.ok(unknownIssue, 'Must name unknown field "admin"')
  assert.equal(unknownIssue.code, 'unrecognized_keys')
})

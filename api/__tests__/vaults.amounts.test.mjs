import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../index.mjs'
import { MemoryStore } from '../../apilib/store.mjs'

// These suites create many vaults from one client; lift the write rate limits so they test amounts, not throttling.
process.env.RATE_LIMIT_WRITE_IP_MAX ??= '1000'
process.env.RATE_LIMIT_WRITE_ADDR_MAX ??= '1000'

const STELLAR_CREATOR = 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ'
const STELLAR_VERIFIER = 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2'

function makePayload(overrides = {}) {
  const now = Date.now()
  return {
    name: 'Amount Test Vault',
    creator: STELLAR_CREATOR,
    verifier: STELLAR_VERIFIER,
    amount: '100',
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + 86400000 * 30).toISOString(),
    milestones: [
      { title: 'M1', amount: '100', dueDate: new Date(now + 86400000 * 10).toISOString() },
    ],
    ...overrides,
  }
}

test('POST /vaults - accepts exact milestone sum matching vault amount', async () => {
  const store = new MemoryStore()
  const app = createApp(() => Promise.resolve(store))

  const payload = makePayload({
    amount: '100',
    milestones: [
      { title: 'M1', amount: '33.3333333', dueDate: new Date(Date.now() + 86400000 * 5).toISOString() },
      { title: 'M2', amount: '33.3333333', dueDate: new Date(Date.now() + 86400000 * 10).toISOString() },
      { title: 'M3', amount: '33.3333334', dueDate: new Date(Date.now() + 86400000 * 15).toISOString() },
    ],
  })

  const res = await request(app).post('/api/vaults').send(payload)
  assert.equal(res.status, 201)
  assert.equal(res.body.data.amount, '100')
  assert.equal(res.body.data.milestones.length, 3)
  assert.equal(res.body.data.milestones[0].amount, '33.3333333')
  assert.equal(res.body.data.milestones[1].amount, '33.3333333')
  assert.equal(res.body.data.milestones[2].amount, '33.3333334')
})

test('POST /vaults - rejects when milestone amounts do not sum to vault amount', async () => {
  const store = new MemoryStore()
  const app = createApp(() => Promise.resolve(store))

  const payload = makePayload({
    amount: '100',
    milestones: [
      { title: 'M1', amount: '33.3333333', dueDate: new Date(Date.now() + 86400000 * 5).toISOString() },
      { title: 'M2', amount: '33.3333333', dueDate: new Date(Date.now() + 86400000 * 10).toISOString() },
      { title: 'M3', amount: '33.3333333', dueDate: new Date(Date.now() + 86400000 * 15).toISOString() },
    ],
  })

  const res = await request(app).post('/api/vaults').send(payload)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'Validation failed')
  assert.ok(res.body.details.some(d => d.message === 'milestone amounts must sum to vault amount'))
})

test('POST /vaults - rejects milestone amount of 0', async () => {
  const store = new MemoryStore()
  const app = createApp(() => Promise.resolve(store))

  const payload = makePayload({
    amount: '100',
    milestones: [
      { title: 'M1', amount: '0', dueDate: new Date(Date.now() + 86400000 * 5).toISOString() },
      { title: 'M2', amount: '100', dueDate: new Date(Date.now() + 86400000 * 10).toISOString() },
    ],
  })

  const res = await request(app).post('/api/vaults').send(payload)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'Validation failed')
  assert.ok(res.body.details.some(d => d.message.includes('milestone 1: amount must be > 0')))
})

test('POST /vaults - rejection table for invalid vault amounts and milestones', async () => {
  const store = new MemoryStore()
  const app = createApp(() => Promise.resolve(store))

  const invalidAmounts = ['0.00000001', '1e3', '-1', 'abc', '', null, Infinity]

  for (const invalid of invalidAmounts) {
    // As vault amount
    const resVault = await request(app).post('/api/vaults').send(makePayload({ amount: invalid }))
    assert.equal(resVault.status, 400, `Expected 400 for vault amount: ${invalid}`)
    assert.ok(resVault.body.details.some(d => d.message.includes('amount must be a positive number')))

    // As milestone amount
    const resMilestone = await request(app).post('/api/vaults').send(makePayload({
      amount: '100',
      milestones: [{ title: 'M1', amount: invalid, dueDate: new Date(Date.now() + 86400000 * 10).toISOString() }],
    }))
    assert.equal(resMilestone.status, 400, `Expected 400 for milestone amount: ${invalid}`)
    assert.ok(resMilestone.body.details.some(d => d.message.includes('milestone 1: amount must be')))
  }
})

test('POST /vaults - accepts exact 7-decimal value "0.0000001"', async () => {
  const store = new MemoryStore()
  const app = createApp(() => Promise.resolve(store))

  const payload = makePayload({
    amount: '0.0000001',
    milestones: [
      { title: 'M1', amount: '0.0000001', dueDate: new Date(Date.now() + 86400000 * 10).toISOString() },
    ],
  })

  const res = await request(app).post('/api/vaults').send(payload)
  assert.equal(res.status, 201)
  assert.equal(res.body.data.amount, '0.0000001')
  assert.equal(res.body.data.milestones[0].amount, '0.0000001')
})

test('GET /stats - aggregates amounts as strings with exact decimal sum', async () => {
  const store = new MemoryStore()
  // Clean seeded demo vaults for clear stats check
  store.vaults = []
  store.activity = []
  const app = createApp(() => Promise.resolve(store))

  // Create three active vaults of 0.1
  for (let i = 0; i < 3; i++) {
    const res = await request(app).post('/api/vaults').send(makePayload({
      amount: '0.1',
      milestones: [{ title: 'M1', amount: '0.1', dueDate: new Date(Date.now() + 86400000 * 10).toISOString() }],
    }))
    assert.equal(res.status, 201)
  }

  const statsRes = await request(app).get('/api/stats')
  assert.equal(statsRes.status, 200)
  assert.equal(typeof statsRes.body.data.totalLocked, 'string')
  assert.equal(statsRes.body.data.totalLocked, '0.3')
})

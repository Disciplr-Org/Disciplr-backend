import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import request from 'supertest'

import app from '../index.mjs'
import { getStore, resetStore } from '../../apilib/store.mjs'

const iso = (d = Date.now()) => new Date(d).toISOString()
const STELLAR = 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2'
const CREATOR = 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ'
const API_PREFIX = '/api/v1'

const PG_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/disciplr'
const originalWriteIpMax = process.env.RATE_LIMIT_WRITE_IP_MAX
const originalWriteAddrMax = process.env.RATE_LIMIT_WRITE_ADDR_MAX
process.env.RATE_LIMIT_WRITE_IP_MAX = '1000'
process.env.RATE_LIMIT_WRITE_ADDR_MAX = '1000'

async function hasPostgres() {
  const url = PG_URL
  try {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: url, ssl: false, max: 1 })
    await pool.query('SELECT 1')
    await pool.end()
    return true
  } catch {
    return false
  }
}

const postgresReady = await hasPostgres()
const postgresTest = postgresReady ? test : test.skip

after(() => {
  resetStore()
  if (originalWriteIpMax === undefined) delete process.env.RATE_LIMIT_WRITE_IP_MAX
  else process.env.RATE_LIMIT_WRITE_IP_MAX = originalWriteIpMax
  if (originalWriteAddrMax === undefined) delete process.env.RATE_LIMIT_WRITE_ADDR_MAX
  else process.env.RATE_LIMIT_WRITE_ADDR_MAX = originalWriteAddrMax
})

async function seedVault(vault) {
  const s = await getStore()
  await s.createVault(vault)
  return s
}

function buildVault(overrides = {}) {
  const id = overrides.id || `vault-${randomUUID()}`
  const base = {
    id,
    name: 'Concurrency test vault',
    creator: CREATOR,
    amount: '1000',
    status: 'active',
    startDate: iso(Date.now() - 60_000),
    endDate: iso(Date.now() + 60_000),
    verifier: STELLAR,
    successDestination: CREATOR,
    failureDestination: STELLAR,
    createdAt: iso(),
    updatedAt: iso(),
    milestones: [],
  }
  return { ...base, ...overrides, milestones: overrides.milestones || base.milestones }
}

function buildMilestones(count, status = 'pending') {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index + 1}-${randomUUID()}`,
    title: `Milestone ${index + 1}`,
    amount: String(100 + index),
    dueDate: iso(Date.now() + 60_000 + index * 60_000),
    status,
  }))
}

async function cleanupPgVault(vaultId) {
  const pg = await import('pg')
  const pool = new pg.default.Pool({
    connectionString: PG_URL,
    ssl: false,
  })
  try {
    await pool.query('DELETE FROM activity_log WHERE vault_id = $1', [vaultId])
    await pool.query('DELETE FROM milestones WHERE vault_id = $1', [vaultId])
    await pool.query('DELETE FROM vaults WHERE id = $1', [vaultId])
  } finally {
    await pool.end()
  }
}

async function scenarioA(kind, usePg = false) {
  const vault = buildVault({
    id: `vault-scenario-a-${randomUUID()}`,
    milestones: buildMilestones(20),
  })
  if (usePg) {
    process.env.DATABASE_URL = PG_URL
    await resetStore()
  } else {
    process.env.DATABASE_URL = ''
    await resetStore()
  }
  await seedVault(vault)

  const promises = vault.milestones.map((milestone) =>
    request(app)
      .post(`${API_PREFIX}/vaults/${vault.id}/milestones/${milestone.id}/validate`)
      .send({ verifier: vault.verifier })
  )

  const responses = await Promise.all(promises)
  const success = responses.filter((res) => res.status === 200)
  assert.equal(success.length, 20, `expected 20 successful validates in ${kind}`)

  const store = await getStore()
  const updated = await store.getVault(vault.id)
  assert.equal(updated.status, 'completed')
  assert.ok(updated.milestones.every((milestone) => milestone.status === 'completed'))

  const activity = (await store.listActivity({ vaultId: vault.id })).items
  assert.equal(activity.filter((item) => item.type === 'release').length, 1)
  assert.equal(activity.filter((item) => item.type === 'validate').length, 20)

  if (usePg) await cleanupPgVault(vault.id)
}

async function scenarioB(kind, usePg = false) {
  const vault = buildVault({
    id: `vault-scenario-b-${randomUUID()}`,
    milestones: [
      { id: `m-1-${randomUUID()}`, title: 'Milestone 1', amount: '100', dueDate: iso(Date.now() + 60_000), status: 'pending' },
      { id: `m-2-${randomUUID()}`, title: 'Milestone 2', amount: '200', dueDate: iso(Date.now() + 120_000), status: 'pending' },
    ],
  })

  if (usePg) {
    process.env.DATABASE_URL = PG_URL
    await resetStore()
  } else {
    process.env.DATABASE_URL = ''
    await resetStore()
  }
  await seedVault(vault)

  const requests = Array.from({ length: 10 }, () =>
    request(app)
      .post(`${API_PREFIX}/vaults/${vault.id}/milestones/${vault.milestones[0].id}/validate`)
      .send({ verifier: vault.verifier })
  )

  const responses = await Promise.all(requests)
  const success = responses.filter((res) => res.status === 200)
  const conflict = responses.filter((res) => res.status === 409)
  assert.equal(success.length, 1)
  assert.equal(conflict.length, 9)

  const store = await getStore()
  const updated = await store.getVault(vault.id)
  assert.equal(updated.milestones.filter((milestone) => milestone.status === 'completed').length, 1)
  assert.equal(updated.status, 'active')

  const activity = (await store.listActivity({ vaultId: vault.id })).items
  assert.equal(activity.filter((item) => item.type === 'validate').length, 1)
  assert.equal(activity.filter((item) => item.type === 'release').length, 0)

  if (usePg) await cleanupPgVault(vault.id)
}

async function scenarioC(kind, usePg = false) {
  const finalMilestoneId = `m-final-${randomUUID()}`
  const vault = buildVault({
    id: `vault-scenario-c-${randomUUID()}`,
    milestones: [
      { id: `m-first-${randomUUID()}`, title: 'First milestone', amount: '100', dueDate: iso(Date.now() + 60_000), status: 'completed' },
      { id: finalMilestoneId, title: 'Final milestone', amount: '900', dueDate: iso(Date.now() + 120_000), status: 'pending' },
    ],
  })

  if (usePg) {
    process.env.DATABASE_URL = PG_URL
    await resetStore()
  } else {
    process.env.DATABASE_URL = ''
    await resetStore()
  }
  await seedVault(vault)

  const responses = await Promise.all([
    request(app)
      .post(`${API_PREFIX}/vaults/${vault.id}/milestones/${finalMilestoneId}/validate`)
      .send({ verifier: vault.verifier }),
    request(app)
      .post(`${API_PREFIX}/vaults/${vault.id}/fail`)
      .send({ verifier: vault.verifier }),
  ])

  assert.equal(responses.filter((res) => res.status === 200).length, 1)
  assert.equal(responses.filter((res) => res.status === 409).length, 1)

  const store = await getStore()
  const updated = await store.getVault(vault.id)
  assert.ok(updated.status === 'completed' || updated.status === 'failed')
  assert.ok(updated.status === 'completed' ? updated.milestones.every((milestone) => milestone.status === 'completed') : updated.milestones.every((milestone) => milestone.status !== 'pending'))

  const activity = (await store.listActivity({ vaultId: vault.id })).items
  const releaseCount = activity.filter((item) => item.type === 'release').length
  const redirectCount = activity.filter((item) => item.type === 'redirect').length
  assert.equal(releaseCount + redirectCount, 1)

  if (usePg) await cleanupPgVault(vault.id)
}

async function scenarioD(usePg = false) {
  const vault = buildVault({
    id: `vault-scenario-d-${randomUUID()}`,
    milestones: buildMilestones(2),
  })

  if (usePg) {
    process.env.DATABASE_URL = PG_URL
    await resetStore()
  } else {
    process.env.DATABASE_URL = ''
    await resetStore()
  }
  await seedVault(vault)

  const store = await getStore()
  const originalInsert = store.insertActivityTx.bind(store)
  store.insertActivityTx = async () => {
    throw new Error('simulated activity insert failure')
  }

  const before = await store.getVault(vault.id)
  const res = await request(app)
    .post(`${API_PREFIX}/vaults/${vault.id}/milestones/${vault.milestones[0].id}/validate`)
    .send({ verifier: vault.verifier })

  assert.equal(res.status, 500)

  const after = await store.getVault(vault.id)
  assert.deepEqual(after.status, before.status)
  assert.deepEqual(after.milestones.map((item) => ({ id: item.id, status: item.status })), before.milestones.map((item) => ({ id: item.id, status: item.status })))

  const activity = (await store.listActivity({ vaultId: vault.id })).items
  assert.equal(activity.filter((item) => item.vaultId === vault.id).length, 0)

  store.insertActivityTx = originalInsert
  if (usePg) await cleanupPgVault(vault.id)
}

const memoryScenarioA = () => scenarioA('memory', false)
const memoryScenarioB = () => scenarioB('memory', false)
const memoryScenarioC = () => scenarioC('memory', false)
const memoryScenarioD = () => scenarioD(false)
const pgScenarioA = () => scenarioA('postgres', true)
const pgScenarioB = () => scenarioB('postgres', true)
const pgScenarioC = () => scenarioC('postgres', true)
const pgScenarioD = () => scenarioD(true)

postgresTest('PostgreSQL concurrency: scenario A different milestones', async () => {
  await pgScenarioA()
})

postgresTest('PostgreSQL concurrency: scenario B same milestone', async () => {
  await pgScenarioB()
})

postgresTest('PostgreSQL concurrency: scenario C final validation versus failure', async () => {
  await pgScenarioC()
})

postgresTest('PostgreSQL transaction rollback on activity insert failure', async () => {
  await pgScenarioD()
})

test('Memory store concurrency: scenarios A-C', async () => {
  await memoryScenarioA()
  await memoryScenarioB()
  await memoryScenarioC()
})

test('Memory store transaction rollback on activity insert failure', async () => {
  await memoryScenarioD()
})

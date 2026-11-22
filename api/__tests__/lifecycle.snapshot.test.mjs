// HTTP snapshots for the vault/milestone lifecycle routes.
//
// These pin the observable behaviour of POST /vaults/:id/milestones/:mid/validate
// and POST /vaults/:id/fail (status codes, bodies and the activity rows those
// requests emit) so the refactor onto shared/vaultMachine.mjs can be proven
// behaviour-preserving. Volatile values (ids, timestamps, hashes) are normalised,
// so the snapshots describe shape and values that must not change.
//
// Regenerate after an intentional behaviour change:
//   UPDATE_SNAPSHOTS=1 node --test api/__tests__/lifecycle.snapshot.test.mjs
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import app from '../index.mjs'
import { buildVaultPayload, randomStellarAddress, truncateDb } from './helpers/db.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_FILE = path.join(HERE, '__snapshots__', 'lifecycle.snapshot.json')
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1'

const recorded = {}

function record(scenario, entry) {
  recorded[scenario] ??= []
  recorded[scenario].push(entry)
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const VAULT_ID = /^vault-[0-9a-f]{12}$/
const MILESTONE_ID = /^vault-[0-9a-f]{12}-m\d+$/
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/

function scrub(value, replacements = {}) {
  if (Array.isArray(value)) return value.map((item) => scrub(item, replacements))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, scrub(value[key], replacements)]),
    )
  }
  if (typeof value !== 'string') return value
  if (replacements[value]) return replacements[value]
  if (UUID.test(value)) return '<uuid>'
  if (ISO_TIMESTAMP.test(value)) return '<timestamp>'
  if (HASH.test(value)) return '<hash>'
  if (MILESTONE_ID.test(value)) return '<milestone-id>'
  if (VAULT_ID.test(value)) return '<vault-id>'
  if (STELLAR_ADDRESS.test(value)) return '<stellar-address>'
  return value
}

function capture(res, replacements) {
  return { status: res.status, body: scrub(res.body, replacements) }
}

function replacementsFor(vault, ...addresses) {
  const replacements = { [vault.id]: '<vault-id>' }
  vault.milestones.forEach((m, index) => { replacements[m.id] = `<milestone-${index + 1}>` })
  for (const address of addresses) if (address) replacements[address] = '<stellar-address>'
  return replacements
}

beforeEach(async () => {
  await truncateDb()
})

test('validate lifecycle responses', async () => {
  const verifier = randomStellarAddress()
  const otherVerifier = randomStellarAddress()
  const created = await request(app).post('/api/vaults').send(buildVaultPayload({
    verifier,
    milestones: [
      { title: 'Task 1', amount: 500, dueDate: new Date(Date.now() + 86400000).toISOString() },
      { title: 'Task 2', amount: 500, dueDate: new Date(Date.now() + 2 * 86400000).toISOString() },
    ],
  }))
  assert.equal(created.status, 201)
  const vault = created.body.data
  const mid1 = vault.milestones[0].id
  const mid2 = vault.milestones[1].id
  const replace = replacementsFor(vault, vault.creator, verifier, otherVerifier)

  record('validate-lifecycle', {
    step: 'unknown vault',
    response: capture(await request(app)
      .post('/api/vaults/vault-unknown/milestones/m1/validate')
      .send({ verifier }), replace),
  })
  record('validate-lifecycle', {
    step: 'unknown milestone',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/milestone-unknown/validate`)
      .send({ verifier }), replace),
  })
  record('validate-lifecycle', {
    step: 'wrong verifier',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
      .send({ verifier: otherVerifier }), replace),
  })
  record('validate-lifecycle', {
    step: 'missing verifier',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
      .send({}), replace),
  })
  record('validate-lifecycle', {
    step: 'validate first milestone',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
      .send({ verifier }), replace),
  })
  record('validate-lifecycle', {
    step: 'validate first milestone again',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
      .send({ verifier }), replace),
  })
  record('validate-lifecycle', {
    step: 'validate final milestone',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid2}/validate`)
      .send({ verifier }), replace),
  })
  record('validate-lifecycle', {
    step: 'validate on completed vault',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid2}/validate`)
      .send({ verifier }), replace),
  })

  const fetched = await request(app).get(`/api/vaults/${vault.id}`)
  assert.equal(fetched.status, 200)
  record('validate-lifecycle', {
    step: 'activity rows',
    response: capture(fetched, replace),
  })
})

test('fail lifecycle responses', async () => {
  const verifier = randomStellarAddress()
  const otherVerifier = randomStellarAddress()
  const created = await request(app).post('/api/vaults').send(buildVaultPayload({
    verifier,
    milestones: [
      { title: 'Step 1', amount: 500, dueDate: new Date(Date.now() + 86400000).toISOString() },
      { title: 'Step 2', amount: 500, dueDate: new Date(Date.now() + 2 * 86400000).toISOString() },
    ],
  }))
  assert.equal(created.status, 201)
  const vault = created.body.data
  const mid1 = vault.milestones[0].id
  const replace = replacementsFor(vault, vault.creator, verifier, otherVerifier)

  record('fail-lifecycle', {
    step: 'unknown vault',
    response: capture(await request(app)
      .post('/api/vaults/vault-unknown/fail')
      .send({ verifier }), replace),
  })
  record('fail-lifecycle', {
    step: 'wrong verifier',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/fail`)
      .send({ verifier: otherVerifier }), replace),
  })
  record('fail-lifecycle', {
    step: 'validate first milestone',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid1}/validate`)
      .send({ verifier }), replace),
  })
  record('fail-lifecycle', {
    step: 'fail vault',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/fail`)
      .send({ verifier }), replace),
  })
  record('fail-lifecycle', {
    step: 'fail vault again',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/fail`)
      .send({ verifier }), replace),
  })

  const fetched = await request(app).get(`/api/vaults/${vault.id}`)
  assert.equal(fetched.status, 200)
  record('fail-lifecycle', {
    step: 'activity rows',
    response: capture(fetched, replace),
  })
})

test('deadline responses', async () => {
  const verifier = randomStellarAddress()
  const created = await request(app).post('/api/vaults').send(buildVaultPayload({
    verifier,
    endDate: new Date(Date.now() + 2 * 86400000).toISOString(),
    milestones: [
      { title: 'Deadline task', amount: 1000, dueDate: new Date(Date.now() + 86400000).toISOString() },
    ],
  }))
  assert.equal(created.status, 201)
  const vault = created.body.data
  const mid = vault.milestones[0].id
  const replace = replacementsFor(vault, vault.creator, verifier)

  const afterVaultDeadline = new Date(Date.now() + 3 * 86400000).toISOString()
  record('deadline-responses', {
    step: 'vault deadline passed',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid}/validate?now=${encodeURIComponent(afterVaultDeadline)}`)
      .send({ verifier }), replace),
  })

  const afterMilestoneDue = new Date(Date.now() + 1.5 * 86400000).toISOString()
  record('deadline-responses', {
    step: 'milestone due date passed',
    response: capture(await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mid}/validate?now=${encodeURIComponent(afterMilestoneDue)}`)
      .send({ verifier }), replace),
  })
})

after(() => {
  if (UPDATE) {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true })
    fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(recorded, null, 2)}\n`)
    return
  }
  assert.ok(fs.existsSync(SNAPSHOT_FILE), `missing snapshot file ${SNAPSHOT_FILE}`)
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'))
  assert.deepEqual(recorded, expected)
})

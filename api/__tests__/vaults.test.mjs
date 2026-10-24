import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../index.mjs'
import { truncateDb, buildVaultPayload, getTestPool, randomStellarAddress } from './helpers/db.mjs'

beforeEach(async () => {
  await truncateDb()
})

test('POST /vaults - successfully creates a vault and persists to DB', async () => {
  const payload = buildVaultPayload({
    name: 'Saved Vault',
    milestones: [
      { title: 'Step 1', amount: 300, dueDate: new Date(Date.now() + 86400000).toISOString() },
      { title: 'Step 2', amount: 700, dueDate: new Date(Date.now() + 2 * 86400000).toISOString() },
    ],
  })

  const res = await request(app).post('/api/vaults').send(payload)
  assert.equal(res.status, 201)
  assert.ok(res.body.data)
  const vault = res.body.data
  assert.equal(vault.name, 'Saved Vault')
  assert.equal(vault.creator, payload.creator)
  assert.equal(vault.status, 'active')
  assert.equal(vault.milestones.length, 2)
  assert.equal(vault.milestones[0].title, 'Step 1')
  assert.equal(vault.milestones[1].title, 'Step 2')

  // Direct SQL assertion if Postgres is connected
  const pool = getTestPool()
  if (pool) {
    const { rows: vaultRows } = await pool.query('SELECT * FROM vaults WHERE id = $1', [vault.id])
    assert.equal(vaultRows.length, 1)
    assert.equal(vaultRows[0].creator, payload.creator)
    assert.equal(vaultRows[0].status, 'active')

    const { rows: msRows } = await pool.query('SELECT * FROM milestones WHERE vault_id = $1 ORDER BY sort_order ASC', [vault.id])
    assert.equal(msRows.length, 2)
    assert.equal(msRows[0].title, 'Step 1')
    assert.equal(msRows[0].sort_order, 0)
    assert.equal(msRows[1].title, 'Step 2')
    assert.equal(msRows[1].sort_order, 1)

    const { rows: actRows } = await pool.query('SELECT * FROM activity_log WHERE vault_id = $1', [vault.id])
    assert.equal(actRows.length, 1)
    assert.equal(actRows[0].type, 'create')
  }
})

test('POST /vaults - validation error on invalid payload (empty, invalid stellar address, negative amount)', async () => {
  const badRes1 = await request(app).post('/api/vaults').send({})
  assert.equal(badRes1.status, 400)
  assert.equal(badRes1.body.error, 'Validation failed')
  assert.ok(Array.isArray(badRes1.body.details))

  const badRes2 = await request(app).post('/api/vaults').send(buildVaultPayload({ creator: 'not-stellar' }))
  assert.equal(badRes2.status, 400)
  const msg = (d) => (typeof d === 'string' ? d : d?.message || '');
  assert.ok(badRes2.body.details.some((d) => msg(d).includes('Stellar public key')))

  const badRes3 = await request(app).post('/api/vaults').send(buildVaultPayload({ amount: -10 }))
  assert.equal(badRes3.status, 400)
  assert.ok(badRes3.body.details.some((d) => msg(d).includes('amount must be a positive number')))

  const badRes4 = await request(app).post('/api/vaults').send(buildVaultPayload({ milestones: [] }))
  assert.equal(badRes4.status, 400)
  assert.ok(badRes4.body.details.some((d) => msg(d).includes('between 1 and 20 milestones are required')))
})

test('GET /vaults - lists vaults and supports creator & status filters', async () => {
  const creatorA = randomStellarAddress()
  const creatorB = randomStellarAddress()

  const v1 = await request(app).post('/api/vaults').send(buildVaultPayload({ creator: creatorA, name: 'Vault A1' }))
  assert.equal(v1.status, 201)
  const v2 = await request(app).post('/api/vaults').send(buildVaultPayload({ creator: creatorA, name: 'Vault A2' }))
  assert.equal(v2.status, 201)
  const v3 = await request(app).post('/api/vaults').send(buildVaultPayload({ creator: creatorB, name: 'Vault B1' }))
  assert.equal(v3.status, 201)

  // Filter by creator
  const resCreatorA = await request(app).get(`/api/vaults?creator=${creatorA}`)
  assert.equal(resCreatorA.status, 200)
  assert.equal(resCreatorA.body.data.length, 2)
  assert.ok(resCreatorA.body.data.every((v) => v.creator === creatorA))

  // Filter by status
  const resStatus = await request(app).get('/api/vaults?status=active')
  assert.equal(resStatus.status, 200)
  assert.ok(resStatus.body.data.length >= 3)
  assert.ok(resStatus.body.data.every((v) => v.status === 'active'))
})

test('GET /vaults/:id - returns vault details with activity or 404 for unknown id', async () => {
  const notFoundRes = await request(app).get('/api/vaults/vault-does-not-exist')
  assert.equal(notFoundRes.status, 404)
  assert.equal(notFoundRes.body.error, 'Vault not found')

  const createRes = await request(app).post('/api/vaults').send(buildVaultPayload())
  assert.equal(createRes.status, 201)
  const vaultId = createRes.body.data.id

  const getRes = await request(app).get(`/api/vaults/${vaultId}`)
  assert.equal(getRes.status, 200)
  assert.equal(getRes.body.data.id, vaultId)
  assert.ok(Array.isArray(getRes.body.data.activity))
  assert.ok(getRes.body.data.activity.length >= 1)
  assert.equal(getRes.body.data.activity[0].type, 'create')
})

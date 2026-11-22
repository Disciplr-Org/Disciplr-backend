import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../index.mjs'
import { getStore } from '../../apilib/store.mjs'
import { expireOverdueVaults } from '../../apilib/expiry.mjs'

test('Vault expiry suite', async (t) => {
  const store = await getStore()
  const creator = 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ'
  const verifier = 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2'
  const originalSecret = process.env.CRON_SECRET

  t.after(() => {
    if (originalSecret === undefined) {
      delete process.env.CRON_SECRET
    } else {
      process.env.CRON_SECRET = originalSecret
    }
  })

  // 1. Auth tests for GET /api/cron/expire-vaults
  await t.test('Auth: 503 when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    const res = await request(app).get('/api/cron/expire-vaults')
    assert.equal(res.status, 503)
    assert.equal(res.headers['cache-control'], 'no-store')
  })

  await t.test('Auth: 401 when CRON_SECRET is missing or invalid', async () => {
    process.env.CRON_SECRET = 'correct-secret-value-1234'

    const resNoAuth = await request(app).get('/api/cron/expire-vaults')
    assert.equal(resNoAuth.status, 401)
    assert.equal(resNoAuth.headers['cache-control'], 'no-store')

    const resWrongAuth = await request(app)
      .get('/api/cron/expire-vaults')
      .set('Authorization', 'Bearer wrong-secret-value')
    assert.equal(resWrongAuth.status, 401)
  })

  // 2. Overdue vault expiry lifecycle
  await t.test('Overdue vault fails on cron, pending milestones fail, completed milestones preserved', async () => {
    process.env.CRON_SECRET = 'correct-secret-value-1234'

    const pastEnd = new Date(Date.now() - 5000).toISOString()
    const pastDue1 = new Date(Date.now() - 10000).toISOString()
    const pastDue2 = new Date(Date.now() - 6000).toISOString()

    const resCreate = await request(app)
      .post('/api/vaults')
      .send({
        name: 'Overdue Expiry Test Vault',
        creator,
        verifier,
        amount: 2000,
        startDate: new Date(Date.now() - 20000).toISOString(),
        endDate: pastEnd,
        milestones: [
          { title: 'Milestone 1 (completed)', amount: 1000, dueDate: pastDue1 },
          { title: 'Milestone 2 (pending)', amount: 1000, dueDate: pastDue2 },
        ],
      })
    assert.equal(resCreate.status, 201)
    const vault = resCreate.body.data

    // Complete milestone 1 beforehand
    const resVal = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${vault.milestones[0].id}/validate?now=${encodeURIComponent(new Date(Date.now() - 12000).toISOString())}`)
      .send({ verifier })
    assert.equal(resVal.status, 200)

    // Call cron route
    const resCron = await request(app)
      .get('/api/cron/expire-vaults')
      .set('Authorization', 'Bearer correct-secret-value-1234')

    assert.equal(resCron.status, 200)
    assert.equal(resCron.headers['cache-control'], 'no-store')
    assert.ok(resCron.body.processed >= 1)

    // Verify vault and milestone state
    const updated = await store.getVault(vault.id)
    assert.equal(updated.status, 'failed')
    assert.equal(updated.milestones[0].status, 'completed')
    assert.equal(updated.milestones[1].status, 'failed')

    // Verify activity has exactly one redirect activity with memo 'Deadline passed'
    const acts = (await store.listActivity({ vaultId: vault.id })).items
    const redirectActs = acts.filter((a) => a.type === 'redirect' && a.memo === 'Deadline passed')
    assert.equal(redirectActs.length, 1)

    // 3. Second cron call is idempotent (no-op, no duplicate activity rows)
    const resCron2 = await request(app)
      .get('/api/cron/expire-vaults')
      .set('Authorization', 'Bearer correct-secret-value-1234')
    assert.equal(resCron2.status, 200)

    const actsAfter = (await store.listActivity({ vaultId: vault.id })).items
    const redirectActsAfter = actsAfter.filter((a) => a.type === 'redirect' && a.memo === 'Deadline passed')
    assert.equal(redirectActsAfter.length, 1)
  })

  // 4. Batch draining across multiple calls (limit and remaining)
  await t.test('Batch draining: overdue vaults are drained across calls with remaining decreasing', async () => {
    process.env.CRON_SECRET = 'correct-secret-value-1234'
    const nowIso = new Date().toISOString()
    const pastEnd = new Date(Date.now() - 10000).toISOString()

    // Create 3 overdue vaults
    for (let i = 0; i < 3; i++) {
      const v = {
        id: `batch-vault-${Date.now()}-${i}`,
        name: `Batch Vault ${i}`,
        creator,
        verifier,
        amount: '500',
        status: 'active',
        startDate: new Date(Date.now() - 30000).toISOString(),
        endDate: pastEnd,
        successDestination: creator,
        failureDestination: verifier,
        createdAt: nowIso,
        updatedAt: nowIso,
        milestones: [{ id: `batch-vault-${Date.now()}-${i}-m1`, title: 'M1', amount: '500', dueDate: pastEnd, status: 'pending' }],
      }
      await store.createVault(v)
    }

    // Call with batch limit 1
    const res1 = await request(app)
      .get('/api/cron/expire-vaults?limit=1')
      .set('Authorization', 'Bearer correct-secret-value-1234')
    assert.equal(res1.status, 200)
    assert.equal(res1.body.processed, 1)
    assert.ok(res1.body.remaining >= 2)

    // Draining loop
    let remaining = res1.body.remaining
    while (remaining > 0) {
      const resNext = await request(app)
        .get('/api/cron/expire-vaults?limit=2')
        .set('Authorization', 'Bearer correct-secret-value-1234')
      assert.equal(resNext.status, 200)
      assert.ok(resNext.body.processed > 0)
      assert.ok(resNext.body.remaining < remaining)
      remaining = resNext.body.remaining
    }
    assert.equal(remaining, 0)
  })

  // 5. Overlapping concurrent calls test
  await t.test('Two overlapping calls process vaults safely without duplicate activities', async () => {
    process.env.CRON_SECRET = 'correct-secret-value-1234'
    const pastEnd = new Date(Date.now() - 15000).toISOString()
    const nowIso = new Date().toISOString()

    const vId = `concurrent-vault-${Date.now()}`
    const vault = {
      id: vId,
      name: 'Concurrent Vault',
      creator,
      verifier,
      amount: '750',
      status: 'active',
      startDate: new Date(Date.now() - 40000).toISOString(),
      endDate: pastEnd,
      successDestination: creator,
      failureDestination: verifier,
      createdAt: nowIso,
      updatedAt: nowIso,
      milestones: [{ id: `${vId}-m1`, title: 'Concurrent M1', amount: '750', dueDate: pastEnd, status: 'pending' }],
    }
    await store.createVault(vault)

    // Concurrent executions
    const [r1, r2] = await Promise.all([
      expireOverdueVaults({ store }),
      expireOverdueVaults({ store }),
    ])

    const totalProcessed = r1.processed + r2.processed
    assert.ok(totalProcessed >= 1)

    const v = await store.getVault(vId)
    assert.equal(v.status, 'failed')
    const acts = (await store.listActivity({ vaultId: vId })).items
    const redirects = acts.filter((a) => a.type === 'redirect' && a.memo === 'Deadline passed')
    assert.equal(redirects.length, 1)
  })
})

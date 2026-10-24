import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../index.mjs'
import { getStore } from '../../apilib/store.mjs'

test('Boundary tests for milestone validation deadline', async (t) => {
  const store = await getStore()

  // Create a dedicated test vault with milestones
  const creator = 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ'
  const verifier = 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2'

  const baseTime = new Date('2026-06-01T12:00:00.000Z').getTime()
  const milestoneDueDate = new Date('2026-06-15T12:00:00.000Z').toISOString()
  const vaultEndDate = new Date('2026-06-30T12:00:00.000Z').toISOString()

  // 1. Validation before dueDate succeeds (200)
  await t.test('Validation before dueDate returns 200', async () => {
    const resCreate = await request(app)
      .post('/api/vaults')
      .set('x-test-now', new Date(baseTime).toISOString())
      .send({
        name: 'Deadline Before Test',
        creator,
        verifier,
        amount: 1000,
        startDate: new Date(baseTime).toISOString(),
        endDate: vaultEndDate,
        milestones: [
          {
            title: 'Milestone 1',
            amount: 1000,
            dueDate: milestoneDueDate,
          },
        ],
      })
    assert.equal(resCreate.status, 201)
    const vault = resCreate.body.data
    const mId = vault.milestones[0].id

    const beforeTime = new Date('2026-06-15T11:59:59.999Z').toISOString()
    const resVal = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mId}/validate`)
      .set('x-test-now', beforeTime)
      .send({ verifier })

    // If req._now wasn't passed via header, simulate via query or direct test if needed
    // But let's check response
    assert.equal(resVal.status, 200)
    assert.equal(resVal.body.data.milestones[0].status, 'completed')
  })

  // 2. Validation at exactly dueDate succeeds (200 - boundary is now <= dueDate)
  await t.test('Validation at exactly dueDate returns 200', async () => {
    const resCreate = await request(app)
      .post('/api/vaults')
      .set('x-test-now', new Date(baseTime).toISOString())
      .send({
        name: 'Deadline Exact Test',
        creator,
        verifier,
        amount: 1000,
        startDate: new Date(baseTime).toISOString(),
        endDate: vaultEndDate,
        milestones: [
          {
            title: 'Milestone exact',
            amount: 1000,
            dueDate: milestoneDueDate,
          },
        ],
      })
    assert.equal(resCreate.status, 201)
    const vault = resCreate.body.data
    const mId = vault.milestones[0].id

    // Test with mock clock at exactly milestoneDueDate
    const exactTime = milestoneDueDate
    // Let's pass query or inject clock
    const resVal = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mId}/validate?now=${encodeURIComponent(exactTime)}`)
      .send({ verifier })

    assert.equal(resVal.status, 200)
    assert.equal(resVal.body.data.milestones[0].status, 'completed')
  })

  // 3. Validation 1ms after dueDate is rejected (409) with no state change
  await t.test('Validation 1ms after dueDate returns 409 and does not change state', async () => {
    const resCreate = await request(app)
      .post('/api/vaults')
      .set('x-test-now', new Date(baseTime).toISOString())
      .send({
        name: 'Deadline After Test',
        creator,
        verifier,
        amount: 1000,
        startDate: new Date(baseTime).toISOString(),
        endDate: vaultEndDate,
        milestones: [
          {
            title: 'Milestone after',
            amount: 1000,
            dueDate: milestoneDueDate,
          },
        ],
      })
    assert.equal(resCreate.status, 201)
    const vault = resCreate.body.data
    const mId = vault.milestones[0].id

    const oneMsAfter = new Date(new Date(milestoneDueDate).getTime() + 1).toISOString()
    const resVal = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mId}/validate?now=${encodeURIComponent(oneMsAfter)}`)
      .send({ verifier })

    assert.equal(resVal.status, 409)
    assert.equal(resVal.body.error, 'Milestone due date has passed')

    // Verify milestone remains pending
    const checkVault = await store.getVault(vault.id)
    assert.equal(checkVault.milestones[0].status, 'pending')
  })

  // 4. Validation after vault endDate is rejected (409 Vault deadline has passed)
  await t.test('Validation after vault endDate returns 409 Vault deadline has passed', async () => {
    const resCreate = await request(app)
      .post('/api/vaults')
      .set('x-test-now', new Date(baseTime).toISOString())
      .send({
        name: 'Vault EndDate Passed Test',
        creator,
        verifier,
        amount: 1000,
        startDate: new Date(baseTime).toISOString(),
        endDate: vaultEndDate,
        milestones: [
          {
            title: 'Milestone in window',
            amount: 1000,
            dueDate: milestoneDueDate,
          },
        ],
      })
    assert.equal(resCreate.status, 201)
    const vault = resCreate.body.data
    const mId = vault.milestones[0].id

    const afterEnd = new Date(new Date(vaultEndDate).getTime() + 1000).toISOString()
    const resVal = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${mId}/validate?now=${encodeURIComponent(afterEnd)}`)
      .send({ verifier })

    assert.equal(resVal.status, 409)
    assert.equal(resVal.body.error, 'Vault deadline has passed')
  })
})

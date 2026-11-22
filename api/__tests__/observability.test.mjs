import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../index.mjs'
import { MemoryStore } from '../../apilib/store.mjs'

test('HTTP-level observability headers and error correlation', async (t) => {
  const store = new MemoryStore()
  const app = createApp(async () => store)

  await t.test('response contains x-request-id header (echoed when valid)', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('x-request-id', 'test-custom-req-id-1234')
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-request-id'], 'test-custom-req-id-1234')
  })

  await t.test('response replaces invalid or oversized x-request-id header', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('x-request-id', 'invalid characters with spaces!')
    assert.equal(res.status, 200)
    assert.notEqual(res.headers['x-request-id'], 'invalid characters with spaces!')
    assert.match(res.headers['x-request-id'], /^[a-zA-Z0-9_-]{1,64}$/)

    const resLong = await request(app)
      .get('/api/health')
      .set('x-request-id', 'a'.repeat(65))
    assert.equal(resLong.status, 200)
    assert.notEqual(resLong.headers['x-request-id'], 'a'.repeat(65))
    assert.match(resLong.headers['x-request-id'], /^[a-zA-Z0-9_-]{1,64}$/)
  })

  await t.test('Server-Timing header is present on data routes', async () => {
    const res = await request(app).get('/api/vaults')
    assert.equal(res.status, 200)
    assert.ok(res.headers['server-timing'], 'Server-Timing header exists')
    assert.match(res.headers['server-timing'], /db;dur=[0-9.]+, total;dur=[0-9.]+/)
  })

  await t.test('500 response body includes requestId matching header', async () => {
    const failingStore = {
      async listVaults() {
        throw new Error('Explosion in store')
      },
    }
    const failApp = createApp(async () => failingStore)

    const res = await request(failApp)
      .get('/api/vaults')
      .set('x-request-id', 'traceable-500-request-id')

    assert.equal(res.status, 500)
    assert.equal(res.headers['x-request-id'], 'traceable-500-request-id')
    assert.equal(res.body.error, 'Internal error')
    assert.equal(res.body.requestId, 'traceable-500-request-id')
  })
})

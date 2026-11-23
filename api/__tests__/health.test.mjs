import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../index.mjs'

test('GET /health returns 200 (liveness) and /ready reports the store', async () => {
  const res = await request(app).get('/api/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'ok')
  assert.equal(res.body.service, 'disciplr-api')
  assert.ok(res.body.time)

  // Store details moved from /health to /ready (liveness is independent of the database).
  const ready = await request(app).get('/api/ready')
  assert.equal(ready.status, 200)
  assert.equal(ready.body.status, 'ok')
  if (process.env.DATABASE_URL) {
    assert.equal(ready.body.store, 'postgres')
  } else {
    assert.equal(ready.body.store, 'memory')
  }
})

test('GET /openapi.json returns valid OpenAPI document', async () => {
  const res = await request(app).get('/api/openapi.json')
  assert.equal(res.status, 200)
  assert.equal(res.body.openapi, '3.0.3')
  assert.ok(res.body.paths)
  assert.ok(res.body.paths['/health'])
  assert.ok(res.body.paths['/vaults'])
})

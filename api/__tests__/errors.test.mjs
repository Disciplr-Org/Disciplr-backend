import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../index.mjs'
import { MemoryStore } from '../../apilib/store.mjs'
import { OPENAPI } from '../../apilib/openapi.mjs'

function buildApp(customStore) {
  const store = customStore || new MemoryStore()
  return { app: createApp(async () => store), store }
}

describe('Error Handling Middleware and Query Validation', () => {
  test('GET /api/vaults?status=bogus -> 400 JSON naming status; no Postgres query is issued', async () => {
    let listVaultsCalled = false
    const customStore = new MemoryStore()
    customStore.listVaults = async (...args) => {
      listVaultsCalled = true
      return MemoryStore.prototype.listVaults.apply(customStore, args)
    }

    const { app } = buildApp(customStore)
    const res = await request(app)
      .get('/api/vaults?status=bogus')
      .expect('Content-Type', /application\/json/)
      .expect(400)

    assert.equal(res.status, 400)
    assert.match(res.body.error, /status/i)
    assert(Array.isArray(res.body.details))
    assert.match(res.body.details[0], /status/i)
    assert.equal(listVaultsCalled, false, 'Store listVaults should not be called on validation failure')
  })

  test('GET /api/vaults?creator=notakey -> 400; ?creator=a&creator=b -> 400', async () => {
    const { app } = buildApp()

    const res1 = await request(app)
      .get('/api/vaults?creator=notakey')
      .expect('Content-Type', /application\/json/)
      .expect(400)

    assert.equal(res1.status, 400)
    assert.match(res1.body.error, /creator/i)
    assert(Array.isArray(res1.body.details))

    const res2 = await request(app)
      .get('/api/vaults?creator=a&creator=b')
      .expect('Content-Type', /application\/json/)
      .expect(400)

    assert.equal(res2.status, 400)
    assert.match(res2.body.error, /creator/i)
    assert(Array.isArray(res2.body.details))
    assert.match(res2.body.details[0], /array/i)
  })

  test('GET /api/vaults?status= (empty string) is treated as absent', async () => {
    const { app } = buildApp()

    const res = await request(app)
      .get('/api/vaults?status=')
      .expect('Content-Type', /application\/json/)
      .expect(200)

    assert.equal(res.status, 200)
    assert(Array.isArray(res.body.data))
  })

  test('GET /api/transactions?vaultId=../../x -> 400', async () => {
    const { app } = buildApp()

    const res = await request(app)
      .get('/api/transactions?vaultId=../../x')
      .expect('Content-Type', /application\/json/)
      .expect(400)

    assert.equal(res.status, 400)
    assert.match(res.body.error, /vaultId/i)
    assert(Array.isArray(res.body.details))
  })

  test('POST /api/vaults with malformed JSON body -> 400 application/json { error: "Malformed JSON body" }', async () => {
    const { app } = buildApp()

    const res = await request(app)
      .post('/api/vaults')
      .set('Content-Type', 'application/json')
      .send('{bad')
      .expect('Content-Type', /application\/json/)
      .expect(400)

    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: 'Malformed JSON body' })
  })

  test('A 101kb body -> 413 JSON', async () => {
    const { app } = buildApp()
    const largeBody = JSON.stringify({ data: 'x'.repeat(1024 * 101) })

    const res = await request(app)
      .post('/api/vaults')
      .set('Content-Type', 'application/json')
      .send(largeBody)
      .expect('Content-Type', /application\/json/)
      .expect(413)

    assert.equal(res.status, 413)
    assert.equal(res.body.error, 'Payload Too Large')
  })

  test('A text/plain POST -> 415 JSON', async () => {
    const { app } = buildApp()

    const res = await request(app)
      .post('/api/vaults')
      .set('Content-Type', 'text/plain')
      .send('hello world')
      .expect('Content-Type', /application\/json/)
      .expect(415)

    assert.equal(res.status, 415)
    assert.match(res.body.error, /Unsupported Media Type/i)
  })

  test('DELETE /api/vaults -> 405 JSON with an Allow header', async () => {
    const { app } = buildApp()

    const res = await request(app)
      .delete('/api/vaults')
      .expect('Content-Type', /application\/json/)
      .expect(405)

    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET, POST')
    assert.match(res.body.error, /Method Not Allowed/i)
  })

  test('DELETE /api/transactions -> 405 JSON with an Allow header', async () => {
    const { app } = buildApp()

    const res = await request(app)
      .delete('/api/transactions')
      .expect('Content-Type', /application\/json/)
      .expect(405)

    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET')
    assert.match(res.body.error, /Method Not Allowed/i)
  })

  test('Thrown non-Error values (strings) inside handlers still yield JSON 500 without leaking stack', async () => {
    const customStore = new MemoryStore()
    customStore.listVaults = async () => {
      throw 'A non-Error string failure'
    }

    const { app } = buildApp(customStore)
    const res = await request(app)
      .get('/api/vaults')
      .expect('Content-Type', /application\/json/)
      .expect(500)

    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { error: 'Internal error' })
  })

  test('Thrown Error inside handlers does not leak err.message in responses', async () => {
    const customStore = new MemoryStore()
    customStore.listVaults = async () => {
      throw new Error('Secret postgres connection error or stack trace')
    }

    const { app } = buildApp(customStore)
    const res = await request(app)
      .get('/api/vaults')
      .expect('Content-Type', /application\/json/)
      .expect(500)

    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { error: 'Internal error' })
  })

  test('Parametrised test: every route in OPENAPI.paths with garbage input asserts JSON content-type and status < 500', async () => {
    process.env.CRON_SECRET = 'test-secret'
    const { app } = buildApp()
    const paths = Object.keys(OPENAPI.paths)

    for (const p of paths) {
      // Substitute path variables like :id, :mid with test string
      const testPath = '/api' + p.replace(/\{([^}]+)\}/g, 'test-$1')

      // 1. GET with garbage query params
      const resGet = await request(app)
        .get(`${testPath}?status=bogus&creator=bogus&vaultId=bogus/bad/path&junk=<script>`)
        .set('Authorization', 'Bearer test-secret')

      const getContentType = resGet.headers['content-type'] || ''
      assert(!/text\/html/i.test(getContentType), `Route GET ${testPath} should not return HTML`)
      assert.match(getContentType, /application\/json/, `Route GET ${testPath} should return JSON`)
      assert(resGet.status < 500, `Route GET ${testPath} returned ${resGet.status} >= 500 with body: ${JSON.stringify(resGet.body)}`)

      // 2. POST with garbage body
      const resPost = await request(app)
        .post(testPath)
        .set('Authorization', 'Bearer test-secret')
        .set('Content-Type', 'application/json')
        .send({ garbage: true, status: 'invalid', creator: 'not-a-key' })

      const postContentType = resPost.headers['content-type'] || ''
      assert(!/text\/html/i.test(postContentType), `Route POST ${testPath} should not return HTML`)
      assert.match(postContentType, /application\/json/, `Route POST ${testPath} should return JSON`)
      assert(resPost.status < 500, `Route POST ${testPath} returned ${resPost.status} >= 500 with body: ${JSON.stringify(resPost.body)}`)
    }
  })
})

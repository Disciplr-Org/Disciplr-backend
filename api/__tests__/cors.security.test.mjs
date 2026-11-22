import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app, { createApp } from '../index.mjs'
import { MemoryStore } from '../../apilib/store.mjs'
import {
  DEFAULT_FRONTEND_ORIGIN,
  ALLOWED_METHODS,
  ALLOWED_HEADERS,
  normalizeOrigin,
  parseAllowedOrigins,
  isOriginAllowed,
  buildCorsOptions,
} from '../../apilib/cors.mjs'
import { buildVaultPayload } from './helpers/db.mjs'

function assertSecurityHeaders(res) {
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  assert.ok(res.headers['content-security-policy'])
  assert.ok(res.headers['content-security-policy'].includes("default-src 'none'"))
  assert.ok(res.headers['content-security-policy'].includes("frame-ancestors 'none'"))
}

// ── Unit Tests: normalizeOrigin ──────────────────────────────────────────────

test('normalizeOrigin - trims whitespace and trailing slashes', () => {
  assert.equal(normalizeOrigin('  https://example.com/  '), 'https://example.com')
  assert.equal(normalizeOrigin('https://example.com///'), 'https://example.com')
  assert.equal(normalizeOrigin('https://example.com'), 'https://example.com')
  assert.equal(normalizeOrigin(''), '')
  assert.equal(normalizeOrigin(null), '')
  assert.equal(normalizeOrigin(undefined), '')
})

// ── Unit Tests: parseAllowedOrigins ──────────────────────────────────────────

test('parseAllowedOrigins - parses comma-separated origins with whitespace and trailing slashes', () => {
  const env = { CORS_ORIGINS: ' https://app.example.com/ ,  https://admin.example.com/ ' }
  assert.deepEqual(parseAllowedOrigins(env), [
    'https://app.example.com',
    'https://admin.example.com',
  ])
})

test('parseAllowedOrigins - filters out empty entries and wildcard *', () => {
  const env = { CORS_ORIGINS: 'https://app.example.com,,  , *, https://other.com' }
  assert.deepEqual(parseAllowedOrigins(env), [
    'https://app.example.com',
    'https://other.com',
  ])
})

test('parseAllowedOrigins - wildcard * alone resolves to empty list (fail-closed for writes)', () => {
  const env = { CORS_ORIGINS: '*' }
  assert.deepEqual(parseAllowedOrigins(env), [])
})

test('parseAllowedOrigins - empty CORS_ORIGINS returns empty array', () => {
  const env = { CORS_ORIGINS: '   ' }
  assert.deepEqual(parseAllowedOrigins(env), [])
})

test('parseAllowedOrigins - defaults to frontend in development/test when unset', () => {
  assert.deepEqual(parseAllowedOrigins({ NODE_ENV: 'development' }), [DEFAULT_FRONTEND_ORIGIN])
  assert.deepEqual(parseAllowedOrigins({ NODE_ENV: 'test' }), [DEFAULT_FRONTEND_ORIGIN])
  assert.deepEqual(parseAllowedOrigins({}), [DEFAULT_FRONTEND_ORIGIN])
})

test('parseAllowedOrigins - fails closed (empty array) in production when unset', () => {
  assert.deepEqual(parseAllowedOrigins({ NODE_ENV: 'production' }), [])
})

// ── Unit Tests: isOriginAllowed ──────────────────────────────────────────────

test('isOriginAllowed - exact origin matching without regex or substring bugs', () => {
  const allowed = ['https://disciplr-frontend.vercel.app', 'https://example.com']

  // Exact matches
  assert.equal(isOriginAllowed('https://disciplr-frontend.vercel.app', allowed), true)
  assert.equal(isOriginAllowed('https://disciplr-frontend.vercel.app/', allowed), true)
  assert.equal(isOriginAllowed('https://example.com', allowed), true)

  // Missing origin (server-to-server / curl)
  assert.equal(isOriginAllowed(undefined, allowed), true)
  assert.equal(isOriginAllowed('', allowed), true)

  // Disallowed origins
  assert.equal(isOriginAllowed('null', allowed), false)
  assert.equal(isOriginAllowed('https://evil-disciplr-frontend.vercel.app', allowed), false)
  assert.equal(isOriginAllowed('https://disciplr-frontend.vercel.app.attacker.com', allowed), false)
  assert.equal(isOriginAllowed('http://disciplr-frontend.vercel.app', allowed), false)
  assert.equal(isOriginAllowed('https://example.com:8080', allowed), false)
  assert.equal(isOriginAllowed('https://random.com', allowed), false)

  // Empty allowed list rejects all origins
  assert.equal(isOriginAllowed('https://example.com', []), false)
})

// ── Unit Tests: buildCorsOptions ─────────────────────────────────────────────

test('buildCorsOptions - returns configured cors options object', () => {
  const opts = buildCorsOptions({ CORS_ORIGINS: 'https://trusted.com' })
  assert.deepEqual(opts.methods, ALLOWED_METHODS)
  assert.deepEqual(opts.allowedHeaders, ALLOWED_HEADERS)
  assert.equal(opts.maxAge, 600)
  assert.equal(opts.credentials, false)

  let calledWithAllowed = null
  opts.origin('https://trusted.com', (err, allow) => { calledWithAllowed = allow })
  assert.equal(calledWithAllowed, true)

  let calledWithDisallowed = null
  opts.origin('https://untrusted.com', (err, allow) => { calledWithDisallowed = allow })
  assert.equal(calledWithDisallowed, false)

  let calledWithoutOrigin = null
  opts.origin(undefined, (err, allow) => { calledWithoutOrigin = allow })
  assert.equal(calledWithoutOrigin, true)
})

// ── Integration Tests: Preflight (OPTIONS) ───────────────────────────────────

test('OPTIONS /api/vaults - allowed origin returns matching Access-Control-Allow-Origin', async () => {
  const res = await request(app)
    .options('/api/vaults')
    .set('Origin', DEFAULT_FRONTEND_ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'Content-Type')

  assert.equal(res.status, 204)
  assert.equal(res.headers['access-control-allow-origin'], DEFAULT_FRONTEND_ORIGIN)
  assert.ok(res.headers['access-control-allow-methods'])
  assert.equal(res.headers['access-control-max-age'], '600')
})

test('OPTIONS /api/vaults - disallowed origin returns no Access-Control-Allow-Origin header', async () => {
  const res = await request(app)
    .options('/api/vaults')
    .set('Origin', 'https://evil.com')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'Content-Type')

  assert.equal(res.status, 204)
  assert.equal(res.headers['access-control-allow-origin'], undefined)
})

// ── Integration Tests: POST endpoints and store isolation ───────────────────

test('POST /api/vaults - allowed origin creates vault; denied origin returns 403 and does not mutate store', async () => {
  const store = new MemoryStore()
  const customApp = createApp(() => store, {
    NODE_ENV: 'test',
    CORS_ORIGINS: 'https://trusted.com',
  })

  const initialCount = store.vaults.length

  // 1. Disallowed origin -> 403 Forbidden, no vault created
  const deniedRes = await request(customApp)
    .post('/api/vaults')
    .set('Origin', 'https://malicious.org')
    .send(buildVaultPayload({ name: 'Malicious Vault' }))

  assert.equal(deniedRes.status, 403)
  assert.equal(deniedRes.body.error, 'Origin not allowed')
  assert.equal(deniedRes.headers['access-control-allow-origin'], undefined)
  assert.equal(store.vaults.length, initialCount)

  // 2. Allowed origin -> 201 Created, vault created
  const allowedRes = await request(customApp)
    .post('/api/vaults')
    .set('Origin', 'https://trusted.com')
    .send(buildVaultPayload({ name: 'Legit Vault' }))

  assert.equal(allowedRes.status, 201)
  assert.equal(allowedRes.headers['access-control-allow-origin'], 'https://trusted.com')
  assert.equal(store.vaults.length, initialCount + 1)
  assert.equal(store.vaults[store.vaults.length - 1].name, 'Legit Vault')

  // 3. Missing origin (curl / server-to-server) -> 201 Created
  const serverRes = await request(customApp)
    .post('/api/vaults')
    .send(buildVaultPayload({ name: 'Backend Vault' }))

  assert.equal(serverRes.status, 201)
  assert.equal(store.vaults.length, initialCount + 2)
})

test('POST /api/vaults/:id/milestones/:mid/validate and /fail - rejected with 403 when origin disallowed', async () => {
  const store = new MemoryStore()
  const customApp = createApp(() => store, {
    NODE_ENV: 'test',
    CORS_ORIGINS: 'https://trusted.com',
  })

  const validateRes = await request(customApp)
    .post('/api/vaults/v-any/milestones/m-any/validate')
    .set('Origin', 'https://evil.com')
    .send({ verifier: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' })

  assert.equal(validateRes.status, 403)
  assert.equal(validateRes.body.error, 'Origin not allowed')

  const failRes = await request(customApp)
    .post('/api/vaults/v-any/fail')
    .set('Origin', 'https://evil.com')
    .send({ verifier: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' })

  assert.equal(failRes.status, 403)
  assert.equal(failRes.body.error, 'Origin not allowed')
})

test('POST /api/vaults - in production with unset CORS_ORIGINS, cross-origin POSTs are rejected', async () => {
  const store = new MemoryStore()
  const prodApp = createApp(() => store, {
    NODE_ENV: 'production',
  })

  // Even the default frontend origin is rejected because production fails closed when unset
  const res = await request(prodApp)
    .post('/api/vaults')
    .set('Origin', DEFAULT_FRONTEND_ORIGIN)
    .send(buildVaultPayload())

  assert.equal(res.status, 403)
  assert.equal(res.body.error, 'Origin not allowed')

  // But server-to-server (no Origin header) works
  const noOriginRes = await request(prodApp)
    .post('/api/vaults')
    .send(buildVaultPayload({ name: 'Server Created' }))

  assert.equal(noOriginRes.status, 201)
})

// ── Integration Tests: GET Cross-Origin ──────────────────────────────────────

test('GET endpoints are accessible cross-origin with Access-Control-Allow-Origin: *', async () => {
  const routes = [
    '/api/health',
    '/api/vaults',
    '/api/stats',
    '/api/transactions',
    '/api/openapi.json',
  ]

  for (const route of routes) {
    const res = await request(app)
      .get(route)
      .set('Origin', 'https://any-site.example.com')

    assert.equal(res.status, 200, `Expected 200 for ${route}`)
    assert.equal(res.headers['access-control-allow-origin'], '*', `Expected wildcard CORS for ${route}`)
  }
})

// ── Integration Tests: Security Headers on 200, 404, 500 ─────────────────────

test('Security headers are present on 200 OK responses', async () => {
  const res = await request(app).get('/api/health')
  assert.equal(res.status, 200)
  assertSecurityHeaders(res)
})

test('Security headers are present on 404 Not Found responses', async () => {
  const res = await request(app).get('/api/non-existent-route-xyz')
  assert.equal(res.status, 404)
  assertSecurityHeaders(res)
})

test('Security headers are present on 500 Internal Error responses', async () => {
  const failingStore = {
    getVault: async () => { throw new Error('Simulated database crash') },
    listVaults: async () => { throw new Error('Simulated database crash') },
  }
  const crashingApp = createApp(() => failingStore)

  const res = await request(crashingApp).get('/api/vaults')
  assert.equal(res.status, 500)
  assert.equal(res.body.error, 'Internal error')
  assertSecurityHeaders(res)
})

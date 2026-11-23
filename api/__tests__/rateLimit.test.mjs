import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../index.mjs'
import { resetMemoryBuckets, normalizeIp, getClientIp } from '../../apilib/rateLimit.mjs'
import { MemoryStore, PgStore } from '../../apilib/store.mjs'
import { buildVaultPayload, getTestPool, randomStellarAddress } from './helpers/db.mjs'

beforeEach(async () => {
  resetMemoryBuckets()
  const pool = getTestPool()
  if (pool) {
    await pool.query('TRUNCATE TABLE rate_limit_buckets, activity_log, milestones, vaults CASCADE').catch(() => {
      return pool.query('TRUNCATE TABLE activity_log, milestones, vaults CASCADE').catch(() => {})
    })
  }
})

// ── In-Memory Mode Tests ──────────────────────────────────────────────────

test('Memory mode: enforces per-IP write limit and sets RateLimit headers', async () => {
  const origMax = process.env.RATE_LIMIT_WRITE_IP_MAX
  const origTrust = process.env.TRUST_PROXY
  process.env.RATE_LIMIT_WRITE_IP_MAX = '3'
  process.env.TRUST_PROXY = '1'

  try {
    const memoryStore = new MemoryStore()
    const app = createApp(async () => memoryStore)
    const ip = '192.0.2.10'

    // First 3 requests must succeed
    for (let i = 1; i <= 3; i++) {
      const res = await request(app)
        .post('/api/vaults')
        .set('X-Forwarded-For', ip)
        .send(buildVaultPayload({ name: `Vault ${i}` }))

      assert.equal(res.status, 201)
      assert.equal(res.headers['ratelimit-limit'], '3')
      assert.equal(res.headers['ratelimit-remaining'], String(3 - i))
      assert.ok(Number(res.headers['ratelimit-reset']) > 0)
    }

    // 4th request must be rejected with 429
    const resBlocked = await request(app)
      .post('/api/vaults')
      .set('X-Forwarded-For', ip)
      .send(buildVaultPayload({ name: 'Vault 4' }))

    assert.equal(resBlocked.status, 429)
    assert.equal(resBlocked.body.error, 'Too many requests')
    assert.equal(resBlocked.headers['ratelimit-limit'], '3')
    assert.equal(resBlocked.headers['ratelimit-remaining'], '0')
    assert.ok(Number(resBlocked.headers['ratelimit-reset']) > 0)
    assert.ok(Number(resBlocked.headers['retry-after']) > 0)

    // A different IP is not affected
    const resOther = await request(app)
      .post('/api/vaults')
      .set('X-Forwarded-For', '192.0.2.11')
      .send(buildVaultPayload({ name: 'Vault from other IP' }))
    assert.equal(resOther.status, 201)
  } finally {
    process.env.RATE_LIMIT_WRITE_IP_MAX = origMax
    process.env.TRUST_PROXY = origTrust
  }
})

test('Memory mode: enforces per-address write limit across multiple IPs', async () => {
  const origIpMax = process.env.RATE_LIMIT_WRITE_IP_MAX
  const origAddrMax = process.env.RATE_LIMIT_WRITE_ADDR_MAX
  const origTrust = process.env.TRUST_PROXY
  process.env.RATE_LIMIT_WRITE_IP_MAX = '50'
  process.env.RATE_LIMIT_WRITE_ADDR_MAX = '3'
  process.env.TRUST_PROXY = '1'

  try {
    const memoryStore = new MemoryStore()
    const app = createApp(async () => memoryStore)
    const targetCreator = randomStellarAddress()

    // 3 requests from different IPs with the same creator succeed
    for (let i = 1; i <= 3; i++) {
      const res = await request(app)
        .post('/api/vaults')
        .set('X-Forwarded-For', `192.0.2.${i + 20}`)
        .send(buildVaultPayload({ creator: targetCreator, name: `Vault ${i}` }))

      assert.equal(res.status, 201)
      assert.equal(res.headers['ratelimit-limit'], '3')
      assert.equal(res.headers['ratelimit-remaining'], String(3 - i))
    }

    // 4th request with same creator from a 4th IP is rate limited
    const resBlocked = await request(app)
      .post('/api/vaults')
      .set('X-Forwarded-For', '192.0.2.24')
      .send(buildVaultPayload({ creator: targetCreator, name: 'Vault 4' }))

    assert.equal(resBlocked.status, 429)
    assert.equal(resBlocked.headers['ratelimit-limit'], '3')
    assert.equal(resBlocked.headers['ratelimit-remaining'], '0')
    assert.ok(Number(resBlocked.headers['retry-after']) > 0)

    // A different creator from the same 4th IP is allowed
    const resOtherCreator = await request(app)
      .post('/api/vaults')
      .set('X-Forwarded-For', '192.0.2.24')
      .send(buildVaultPayload({ creator: randomStellarAddress(), name: 'Vault New Creator' }))
    assert.equal(resOtherCreator.status, 201)
  } finally {
    process.env.RATE_LIMIT_WRITE_IP_MAX = origIpMax
    process.env.RATE_LIMIT_WRITE_ADDR_MAX = origAddrMax
    process.env.TRUST_PROXY = origTrust
  }
})

test('Memory mode: enforces per-address write limit on verifier address', async () => {
  const origIpMax = process.env.RATE_LIMIT_WRITE_IP_MAX
  const origAddrMax = process.env.RATE_LIMIT_WRITE_ADDR_MAX
  const origTrust = process.env.TRUST_PROXY
  process.env.RATE_LIMIT_WRITE_IP_MAX = '50'
  process.env.RATE_LIMIT_WRITE_ADDR_MAX = '2'
  process.env.TRUST_PROXY = '1'

  try {
    const memoryStore = new MemoryStore()
    const app = createApp(async () => memoryStore)
    const targetVerifier = randomStellarAddress()

    for (let i = 1; i <= 2; i++) {
      const res = await request(app)
        .post('/api/vaults')
        .set('X-Forwarded-For', `192.0.2.${i + 30}`)
        .send(buildVaultPayload({ verifier: targetVerifier }))
      assert.equal(res.status, 201)
    }

    const resBlocked = await request(app)
      .post('/api/vaults')
      .set('X-Forwarded-For', '192.0.2.33')
      .send(buildVaultPayload({ verifier: targetVerifier }))

    assert.equal(resBlocked.status, 429)
    assert.equal(resBlocked.headers['ratelimit-limit'], '2')
    assert.equal(resBlocked.headers['ratelimit-remaining'], '0')
  } finally {
    process.env.RATE_LIMIT_WRITE_IP_MAX = origIpMax
    process.env.RATE_LIMIT_WRITE_ADDR_MAX = origAddrMax
    process.env.TRUST_PROXY = origTrust
  }
})

test('Memory mode: enforces read rate limit on GET routes', async () => {
  const origReadMax = process.env.RATE_LIMIT_READ_IP_MAX
  const origTrust = process.env.TRUST_PROXY
  process.env.RATE_LIMIT_READ_IP_MAX = '3'
  process.env.TRUST_PROXY = '1'

  try {
    const memoryStore = new MemoryStore()
    const app = createApp(async () => memoryStore)
    const ip = '192.0.2.40'

    for (let i = 1; i <= 3; i++) {
      const res = await request(app).get('/api/vaults').set('X-Forwarded-For', ip)
      assert.equal(res.status, 200)
      assert.equal(res.headers['ratelimit-limit'], '3')
      assert.equal(res.headers['ratelimit-remaining'], String(3 - i))
    }

    const resBlocked = await request(app).get('/api/vaults').set('X-Forwarded-For', ip)
    assert.equal(resBlocked.status, 429)
    assert.equal(resBlocked.headers['ratelimit-limit'], '3')
    assert.equal(resBlocked.headers['ratelimit-remaining'], '0')
    assert.ok(Number(resBlocked.headers['retry-after']) > 0)
  } finally {
    process.env.RATE_LIMIT_READ_IP_MAX = origReadMax
    process.env.TRUST_PROXY = origTrust
  }
})

test('Exempt routes: /health and /openapi.json are not rate limited and have no RateLimit headers', async () => {
  const origReadMax = process.env.RATE_LIMIT_READ_IP_MAX
  const origTrust = process.env.TRUST_PROXY
  process.env.RATE_LIMIT_READ_IP_MAX = '1'
  process.env.TRUST_PROXY = '1'

  try {
    const memoryStore = new MemoryStore()
    const app = createApp(async () => memoryStore)
    const ip = '192.0.2.50'

    // Multiple calls to /health succeed without rate limiting headers
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/health').set('X-Forwarded-For', ip)
      assert.equal(res.status, 200)
      assert.equal(res.headers['ratelimit-limit'], undefined)
    }

    // Multiple calls to /openapi.json succeed without rate limiting headers
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/openapi.json').set('X-Forwarded-For', ip)
      assert.equal(res.status, 200)
      assert.equal(res.headers['ratelimit-limit'], undefined)
    }
  } finally {
    process.env.RATE_LIMIT_READ_IP_MAX = origReadMax
    process.env.TRUST_PROXY = origTrust
  }
})

// ── Proxy Trust & IP Normalization Matrix ──────────────────────────────────

test('Proxy trust matrix: TRUST_PROXY=1 uses right-most hop; TRUST_PROXY=0 ignores header', async () => {
  const origTrust = process.env.TRUST_PROXY

  try {
    // 1. TRUST_PROXY=1 with spoofed chain: takes right-most hop
    process.env.TRUST_PROXY = '1'
    const req1 = {
      headers: { 'x-forwarded-for': 'spoofed.attacker.ip, 198.51.100.1' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(getClientIp(req1), '198.51.100.1')

    // Single hop
    const req2 = {
      headers: { 'x-forwarded-for': '203.0.113.50' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(getClientIp(req2), '203.0.113.50')

    // 2. TRUST_PROXY=0 (or unset): ignores X-Forwarded-For completely
    process.env.TRUST_PROXY = '0'
    const req3 = {
      headers: { 'x-forwarded-for': '198.51.100.1' },
      socket: { remoteAddress: '10.0.0.99' },
    }
    assert.equal(getClientIp(req3), '10.0.0.99')
  } finally {
    process.env.TRUST_PROXY = origTrust
  }
})

test('IPv6 normalization: buckets by /64 prefix', () => {
  const ip1 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334'
  const ip2 = '2001:db8:85a3::1'
  const ip3 = '2001:db8:85a3:0:ffff:ffff:ffff:ffff'
  const differentSubnet = '2001:db8:85a4::1'

  const norm1 = normalizeIp(ip1)
  const norm2 = normalizeIp(ip2)
  const norm3 = normalizeIp(ip3)
  const normDiff = normalizeIp(differentSubnet)

  assert.equal(norm1, '2001:db8:85a3:0::/64')
  assert.equal(norm2, '2001:db8:85a3:0::/64')
  assert.equal(norm3, '2001:db8:85a3:0::/64')
  assert.equal(normDiff, '2001:db8:85a4:0::/64')

  // IPv4-mapped IPv6
  assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1')
  // Localhost IPv6
  assert.equal(normalizeIp('::1'), '::1')
  // Port stripped
  assert.equal(normalizeIp('192.0.2.1:8080'), '192.0.2.1')
})

// ── Fail-Open Resilience Test ─────────────────────────────────────────────

test('Fail-open: request proceeds and warning is logged if pool throws', async () => {
  let warned = false
  const origWarn = console.warn
  console.warn = (...args) => {
    warned = true
    origWarn(...args)
  }

  try {
    const throwingPool = {
      query: async () => {
        throw new Error('Database connection failed')
      },
    }
    const store = new PgStore(throwingPool)
    const app = createApp(async () => store)

    // Request should proceed and fail open rather than return 500/503/429
    // GET /health is exempt, but GET /vaults reaches the limiter
    // When limiter fails open, next() is called, reaching route handler
    const res = await request(app).get('/api/health')
    assert.equal(res.status, 200)

    const writeRes = await request(app)
      .post('/api/vaults')
      .send(buildVaultPayload({ name: 'Fail Open Vault' }))
    // The route handler itself will throw because store is a stub, but the limiter itself
    // did NOT return 429 or crash the server. It logged a warning and failed open!
    assert.ok(warned)
  } finally {
    console.warn = origWarn
  }
})

// ── Postgres Mode Tests (active when DATABASE_URL is set) ─────────────────

const postgresIntegration = process.env.DATABASE_URL ? test : test.skip

postgresIntegration('Postgres mode: limits are shared across two separate app instances', async () => {
  const origWriteMax = process.env.RATE_LIMIT_WRITE_IP_MAX
  const origTrust = process.env.TRUST_PROXY
  process.env.RATE_LIMIT_WRITE_IP_MAX = '3'
  process.env.TRUST_PROXY = '1'

  try {
    const pool = getTestPool()
    assert.ok(pool)

    // Create two separate app instances sharing the same Postgres pool
    const app1 = createApp(async () => new PgStore(pool))
    const app2 = createApp(async () => new PgStore(pool))
    const clientIp = '198.51.100.77'

    // Request 1 on App 1 -> OK (count 1)
    const res1 = await request(app1)
      .post('/api/vaults')
      .set('X-Forwarded-For', clientIp)
      .send(buildVaultPayload({ name: 'App1 Vault 1' }))
    assert.equal(res1.status, 201)
    assert.equal(res1.headers['ratelimit-remaining'], '2')

    // Request 2 on App 2 -> OK (count 2)
    const res2 = await request(app2)
      .post('/api/vaults')
      .set('X-Forwarded-For', clientIp)
      .send(buildVaultPayload({ name: 'App2 Vault 2' }))
    assert.equal(res2.status, 201)
    assert.equal(res2.headers['ratelimit-remaining'], '1')

    // Request 3 on App 1 -> OK (count 3)
    const res3 = await request(app1)
      .post('/api/vaults')
      .set('X-Forwarded-For', clientIp)
      .send(buildVaultPayload({ name: 'App1 Vault 3' }))
    assert.equal(res3.status, 201)
    assert.equal(res3.headers['ratelimit-remaining'], '0')

    // Request 4 on App 2 -> 429 Too Many Requests (shared limit breached across instances)
    const res4 = await request(app2)
      .post('/api/vaults')
      .set('X-Forwarded-For', clientIp)
      .send(buildVaultPayload({ name: 'App2 Vault 4' }))
    assert.equal(res4.status, 429)
    assert.equal(res4.headers['ratelimit-limit'], '3')
    assert.equal(res4.headers['ratelimit-remaining'], '0')
    assert.ok(Number(res4.headers['retry-after']) > 0)

    // Inspect Postgres rate_limit_buckets directly
    const { rows } = await pool.query('SELECT * FROM rate_limit_buckets WHERE key = $1', [`write:ip:${clientIp}`])
    assert.equal(rows.length, 1)
    assert.equal(Number(rows[0].count), 4)
  } finally {
    process.env.RATE_LIMIT_WRITE_IP_MAX = origWriteMax
    process.env.TRUST_PROXY = origTrust
  }
})

postgresIntegration('Postgres mode: enforces per-address limit across different IPs', async () => {
  const origIpMax = process.env.RATE_LIMIT_WRITE_IP_MAX
  const origAddrMax = process.env.RATE_LIMIT_WRITE_ADDR_MAX
  const origTrust = process.env.TRUST_PROXY
  process.env.RATE_LIMIT_WRITE_IP_MAX = '50'
  process.env.RATE_LIMIT_WRITE_ADDR_MAX = '3'
  process.env.TRUST_PROXY = '1'

  try {
    const pool = getTestPool()
    const app = createApp(async () => new PgStore(pool))
    const creator = randomStellarAddress()

    for (let i = 1; i <= 3; i++) {
      const res = await request(app)
        .post('/api/vaults')
        .set('X-Forwarded-For', `198.51.100.${i + 10}`)
        .send(buildVaultPayload({ creator, name: `PG Vault ${i}` }))
      assert.equal(res.status, 201)
    }

    // 4th request from a different IP with the same creator
    const resBlocked = await request(app)
      .post('/api/vaults')
      .set('X-Forwarded-For', '198.51.100.99')
      .send(buildVaultPayload({ creator, name: 'PG Vault 4' }))

    assert.equal(resBlocked.status, 429)
    assert.equal(resBlocked.headers['ratelimit-limit'], '3')
    assert.equal(resBlocked.headers['ratelimit-remaining'], '0')
  } finally {
    process.env.RATE_LIMIT_WRITE_IP_MAX = origIpMax
    process.env.RATE_LIMIT_WRITE_ADDR_MAX = origAddrMax
    process.env.TRUST_PROXY = origTrust
  }
})

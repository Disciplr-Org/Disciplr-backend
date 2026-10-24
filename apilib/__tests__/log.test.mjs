import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import express from 'express'
import request from 'supertest'
import {
  createLogger,
  isValidRequestId,
  generateRequestId,
  statementFingerprint,
  wrapPoolForTiming,
  requestIdMiddleware,
} from '../log.mjs'

test('isValidRequestId validation', () => {
  assert.equal(isValidRequestId('abc-123_XYZ'), true)
  assert.equal(isValidRequestId('01ARZ3NDEKTSV4RRFFQ69G5FAV'), true)
  assert.equal(isValidRequestId(''), false)
  assert.equal(isValidRequestId(null), false)
  assert.equal(isValidRequestId(undefined), false)
  assert.equal(isValidRequestId('a'.repeat(64)), true)
  assert.equal(isValidRequestId('a'.repeat(65)), false)
  assert.equal(isValidRequestId('has space'), false)
  assert.equal(isValidRequestId('has\ninjection'), false)
  assert.equal(isValidRequestId('has;special'), false)
})

test('statementFingerprint normalizes query parameters and literals', () => {
  const sql = 'SELECT * FROM vaults WHERE id = $1 AND amount > 100 AND name = \'test\''
  const fingerprint = statementFingerprint(sql)
  assert.equal(fingerprint, 'SELECT * FROM vaults WHERE id = ? AND amount > ? AND name = ?')
  assert.doesNotMatch(fingerprint, /\$1/)
  assert.doesNotMatch(fingerprint, /100/)
  assert.doesNotMatch(fingerprint, /'test'/)
})

test('pino logger redacts sensitive fields', async () => {
  let logLines = []
  const dest = new Writable({
    write(chunk, encoding, callback) {
      logLines.push(JSON.parse(chunk.toString()))
      callback()
    },
  })

  const testLogger = createLogger({ level: 'info' }, dest)

  testLogger.info({
    req: {
      headers: {
        authorization: 'Bearer secret-jwt-token-12345',
        cookie: 'sessionId=secret-cookie-999',
      },
    },
    signedXdr: 'AAAA...stellar-signed-xdr...',
    secret: 'super-secret-key',
    safeField: 'visible-value',
  })

  assert.equal(logLines.length, 1)
  const line = logLines[0]
  assert.equal(line.req.headers.authorization, '[Redacted]')
  assert.equal(line.req.headers.cookie, '[Redacted]')
  assert.equal(line.signedXdr, '[Redacted]')
  assert.equal(line.secret, '[Redacted]')
  assert.equal(line.safeField, 'visible-value')
})

test('requestIdMiddleware attaches requestId, child logger, and access logs', async () => {
  let logLines = []
  const dest = new Writable({
    write(chunk, encoding, callback) {
      logLines.push(JSON.parse(chunk.toString()))
      callback()
    },
  })

  const testLogger = createLogger({ level: 'info' }, dest)

  const app = express()
  app.use(requestIdMiddleware(testLogger))
  app.get('/vaults/:id', (req, res) => {
    res.json({ id: req.params.id })
  })
  app.get('/error-route', (req, res) => {
    res.status(500).json({ error: 'fail' })
  })
  app.get('/warn-route', (req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  // 1. Valid inbound request ID echoed
  const res1 = await request(app)
    .get('/vaults/v-123')
    .set('x-request-id', 'custom-inbound-id')
  assert.equal(res1.status, 200)
  assert.equal(res1.headers['x-request-id'], 'custom-inbound-id')

  // 2. Invalid inbound request ID replaced
  const res2 = await request(app)
    .get('/vaults/v-456')
    .set('x-request-id', 'invalid characters!@#$')
  assert.equal(res2.status, 200)
  assert.notEqual(res2.headers['x-request-id'], 'invalid characters!@#$')
  assert.ok(isValidRequestId(res2.headers['x-request-id']))

  // 3. 4xx warning access log
  await request(app).get('/warn-route')

  // 4. 5xx error access log
  await request(app).get('/error-route')

  // Verify access log entries
  const accessLogs = logLines.filter((l) => l.route)
  assert.ok(accessLogs.length >= 4)

  const v1Log = accessLogs.find((l) => l.reqId === 'custom-inbound-id')
  assert.ok(v1Log)
  assert.equal(v1Log.method, 'GET')
  assert.equal(v1Log.route, '/vaults/:id') // route pattern, not raw URL!
  assert.equal(v1Log.status, 200)
  assert.ok(typeof v1Log.durationMs === 'number')

  const warnLog = accessLogs.find((l) => l.status === 404)
  assert.ok(warnLog)
  assert.equal(warnLog.level, 40) // pino 'warn' is 40

  const errorLog = accessLogs.find((l) => l.status === 500)
  assert.ok(errorLog)
  assert.equal(errorLog.level, 50) // pino 'error' is 50
})

test('wrapPoolForTiming records duration and logs slow queries without parameters', async () => {
  let logLines = []
  const dest = new Writable({
    write(chunk, encoding, callback) {
      logLines.push(JSON.parse(chunk.toString()))
      callback()
    },
  })

  const testLogger = createLogger({ level: 'info' }, dest)

  const stubPool = {
    async query(sql, params) {
      // Simulate query duration
      await new Promise((r) => setTimeout(r, 60))
      return { rows: [] }
    },
    async connect() {
      return {
        async query(sql, params) {
          await new Promise((r) => setTimeout(r, 60))
          return { rows: [] }
        },
        release() {},
      }
    },
  }

  process.env.SLOW_QUERY_MS = '50'
  const wrapped = wrapPoolForTiming(stubPool, testLogger)

  await wrapped.query('SELECT * FROM vaults WHERE secret_key = $1 AND id = 999', ['super-secret-param'])

  const slowLogs = logLines.filter((l) => l.slow_query)
  assert.equal(slowLogs.length, 1)
  const slowLog = slowLogs[0]
  assert.ok(slowLog.durationMs >= 50)
  assert.equal(slowLog.fingerprint, 'SELECT * FROM vaults WHERE secret_key = ? AND id = ?')
  assert.doesNotMatch(JSON.stringify(slowLog), /super-secret-param/)
})

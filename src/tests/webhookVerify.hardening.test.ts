import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import express, { type Express } from 'express'
import request from 'supertest'
import * as crypto from 'crypto'
import { _resetEnvForTesting, initEnv } from '../config/env.js'
import { webhookVerify, BoundedReplayStore, confirmedNonces, pendingNonces } from '../middleware/webhookVerify.js'
import { register } from '../observability/metricsRegistry.js'

// ---------------------------------------------------------------------------
// Replay-protection / verification hardening tests (issue #1532).
//
// Runs under the repository's primary Jest runner (the legacy vitest suite —
// src/tests/webhookVerify.test.ts — is excluded from `npm test` because vitest
// cannot run in this environment). These tests cover the same contract plus the
// new bounded-memory store, payload-size bound, and telemetry.
// ---------------------------------------------------------------------------

const buildEnv = (overrides: Record<string, string> = {}) =>
  ({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres',
    DOWNLOAD_SECRET: 'test-download-secret-at-least-16-chars',
    WEBHOOK_INBOUND_SECRET: 'test-secret',
    WEBHOOK_INBOUND_SKEW_MS: '300000',
    WEBHOOK_INBOUND_MAX_BODY_BYTES: '100',
    WEBHOOK_REPLAY_CACHE_SIZE: '20',
    ...overrides,
  } as Record<string, string>)

const boot = (overrides: Record<string, string> = {}) => {
  _resetEnvForTesting()
  initEnv(buildEnv(overrides))
}

const sign = (secret: string, timestamp: number, nonce: string, body: string) => {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex')
  return `sha256=${digest}`
}

const minimalApp = (): Express => {
  const app = express()
  app.post('/webhook', webhookVerify, (_req, res) => {
    res.status(200).json({ ok: true })
  })
  return app
}

describe('webhookVerify (hardening)', () => {
  let app: Express

  beforeEach(() => {
    boot()
    confirmedNonces.clear()
    pendingNonces.clear()
    app = minimalApp()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('accepts a valid request within the skew window', async () => {
    const ts = Date.now()
    const nonce = 'ok-nonce-1'
    const body = JSON.stringify({ test: 'data' })
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('test-secret', ts, nonce, body))
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('rejects a request with missing headers', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ test: 'data' }))
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Missing required webhook headers' })
  })

  it('rejects an unparseable timestamp header', async () => {
    const ts = Date.now()
    const nonce = 'bad-ts'
    const body = JSON.stringify({ test: 'data' })
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('test-secret', ts, nonce, body))
      .set('x-webhook-timestamp', 'not-a-number')
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid timestamp header' })
  })

  it('rejects a request outside the skew window', async () => {
    const ts = Date.now() - 600_000 // 10 minutes ago (> 5 min skew)
    const nonce = 'outside-1'
    const body = JSON.stringify({ test: 'data' })
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('test-secret', ts, nonce, body))
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Webhook request outside of allowed time window' })
  })

  it('rejects a request with an invalid signature', async () => {
    const ts = Date.now()
    const nonce = 'bad-sig-1'
    const body = JSON.stringify({ test: 'data' })
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('wrong-secret', ts, nonce, body))
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid webhook signature' })
  })

  it('rejects a request with a tampered body', async () => {
    const ts = Date.now()
    const nonce = 'tampered-1'
    const body = JSON.stringify({ test: 'data' })
    const sig = sign('test-secret', ts, nonce, body)
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sig)
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ test: 'tampered' }))
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid webhook signature' })
  })

  it('rejects a replayed request with the same nonce', async () => {
    const ts = Date.now()
    const nonce = 'replay-1'
    const body = JSON.stringify({ test: 'data' })
    const sig = sign('test-secret', ts, nonce, body)
    const send = () =>
      request(app)
        .post('/webhook')
        .set('x-webhook-signature', sig)
        .set('x-webhook-timestamp', String(ts))
        .set('x-webhook-nonce', nonce)
        .set('Content-Type', 'application/json')
        .send(body)

    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(401)
  })

  it('rejects exactly one of two concurrent duplicate requests (TOCTOU)', async () => {
    const ts = Date.now()
    const nonce = 'concurrent-1'
    const body = JSON.stringify({ test: 'concurrent' })
    const sig = sign('test-secret', ts, nonce, body)
    const send = () =>
      request(app)
        .post('/webhook')
        .set('x-webhook-signature', sig)
        .set('x-webhook-timestamp', String(ts))
        .set('x-webhook-nonce', nonce)
        .set('Content-Type', 'application/json')
        .send(body)

    const [r1, r2] = await Promise.all([send(), send()])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 401])
    const rejected = r1.status === 401 ? r1 : r2
    expect(rejected.body).toEqual({ error: 'Replayed webhook request' })
  })

  it('rejects a non-JSON body with 400', async () => {
    const ts = Date.now()
    const nonce = 'bad-json-1'
    const body = 'this is not json'
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('test-secret', ts, nonce, body))
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'text/plain')
      .send(body)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid JSON body' })
  })

  it('rejects an oversized payload with 413 without consuming the nonce', async () => {
    const ts = Date.now()
    const nonce = 'big-1'
    const big = JSON.stringify({ filler: 'x'.repeat(400) }) // > 100-byte limit

    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('test-secret', ts, nonce, big))
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(big)
    expect(res.status).toBe(413)
    expect(res.body.error).toMatch(/Payload exceeds/i)

    // Same nonce is NOT burned — a valid small body with the same nonce works.
    const small = JSON.stringify({ test: 'data' })
    const ok = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('test-secret', ts, nonce, small))
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(small)
    expect(ok.status).toBe(200)
  })

  it('returns 500 when the inbound secret is not configured', async () => {
    boot({ WEBHOOK_INBOUND_SECRET: '' })
    app = minimalApp()
    const ts = Date.now()
    const nonce = 'nosecret-1'
    const body = JSON.stringify({ test: 'data' })
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('test-secret', ts, nonce, body))
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Webhook verification secret is not configured' })
  })

  it('never leaks the secret, signature, or body in error responses', async () => {
    const ts = Date.now()
    const nonce = 'leak-1'
    const body = JSON.stringify({ test: 'secret-ish' })
    const badRes = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', sign('wrong-secret', ts, nonce, body))
      .set('x-webhook-timestamp', String(ts))
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)
    const json = JSON.stringify(badRes.body)
    expect(json).not.toContain('test-secret')
    expect(json).not.toContain('wrong-secret')
    expect(json).not.toContain('secret-ish')
  })

  it('records structured telemetry for success and replay outcomes', async () => {
    const ts = Date.now()
    const nonce = 'metrics-1'
    const body = JSON.stringify({ test: 'data' })
    const sig = sign('test-secret', ts, nonce, body)
    const send = () =>
      request(app)
        .post('/webhook')
        .set('x-webhook-signature', sig)
        .set('x-webhook-timestamp', String(ts))
        .set('x-webhook-nonce', nonce)
        .set('Content-Type', 'application/json')
        .send(body)

    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(401)

    // Rendering the counter proves the metric exists and carries the expected
    // high-cardinality outcome labels without exposing any sensitive material.
    const text = await register.metrics()
    expect(text).toContain('disciplr_webhook_inbound_verify_total{outcome="success"}')
    expect(text).toContain('disciplr_webhook_inbound_verify_total{outcome="replay"}')
    expect(text).not.toContain('test-secret')
  })
})

describe('BoundedReplayStore (bounded memory dedup)', () => {
  it('evicts the oldest entry once capacity is exceeded', () => {
    const store = new BoundedReplayStore(3, 300_000)
    store.add('a', Date.now())
    store.add('b', Date.now())
    store.add('c', Date.now())
    expect(store.size).toBe(3)
    store.add('d', Date.now())
    expect(store.size).toBe(3)
    expect(store.has('a')).toBe(false) // oldest evicted
    expect(store.has('d')).toBe(true)
  })

  it('lazily expires a stale entry on access', () => {
    const now = Date.now()
    const store = new BoundedReplayStore(10, 5_000)
    store.add('stale', now - 60_000) // far outside 5s skew
    store.add('fresh', now)
    expect(store.has('stale')).toBe(false)
    expect(store.size).toBe(1) // stale reclaimed
    expect(store.has('fresh')).toBe(true)
  })

  it('sweep() removes expired entries but keeps fresh ones', () => {
    const now = Date.now()
    const store = new BoundedReplayStore(10, 5_000)
    store.add('old', now - 60_000)
    store.add('new', now)
    store.sweep()
    expect(store.has('new')).toBe(true)
    expect(store.size).toBe(1)
  })

  it('delete() removes a specific entry', () => {
    const store = new BoundedReplayStore(10, 300_000)
    store.add('a', Date.now())
    expect(store.has('a')).toBe(true)
    expect(store.delete('a')).toBe(true)
    expect(store.has('a')).toBe(false)
    expect(store.delete('a')).toBe(false)
  })
})
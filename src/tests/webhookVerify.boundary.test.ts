/**
 * Focused boundary tests for the inbound webhook verification middleware
 * (`src/middleware/webhookVerify.ts`).
 *
 * Builds on the existing signature/replay/TOCTOU suite by covering the payload
 * boundary:
 *   - malformed (non-object) payloads → 400
 *   - wrong-network payloads → 400 (network invariant)
 *   - corrected retry with the same nonce is allowed after a malformed body
 *   - tampering → 401, replay → 401 (regression anchors)
 */
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import crypto from 'crypto'
import { jest } from '@jest/globals'

jest.unstable_mockModule('../config/index.js', () => ({
  getEnv: () => ({
    WEBHOOK_INBOUND_SECRET: 'test-secret',
    WEBHOOK_INBOUND_SKEW_MS: 300000, // 5 minutes
  }),
  // webhookVerify -> logger -> config: provide the subset logger reads at
  // module-init time so the mock never has to shadow the whole config module.
  config: { nodeEnv: 'test', logLevel: 'info' },
}))

const { webhookVerify, validateWebhookBody, getExpectedInboundNetwork } = await import(
  '../middleware/webhookVerify.js'
)

const TESTNET = 'Test SDF Network ; September 2015'
const MAINNET = 'Public Global Stellar Network ; September 2015'

const app = express()
app.post(
  '/webhook',
  webhookVerify,
  (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  },
)

const sign = (secret: string, timestamp: number, nonce: string, body: string) => {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex')
  return `sha256=${digest}`
}

const send = (
  body: string,
  opts: { secret?: string; timestamp?: number; nonce?: string; contentType?: string } = {},
) => {
  const timestamp = opts.timestamp ?? Date.now()
  const nonce = opts.nonce ?? `nonce-${Math.random()}`
  const secret = opts.secret ?? 'test-secret'
  const signature = sign(secret, timestamp, nonce, body)
  return request(app)
    .post('/webhook')
    .set('x-webhook-signature', signature)
    .set('x-webhook-timestamp', timestamp.toString())
    .set('x-webhook-nonce', nonce)
    .set('Content-Type', opts.contentType ?? 'application/json')
    .send(body)
}

afterEach(() => {
  delete process.env.SOROBAN_NETWORK_PASSPHRASE
  delete process.env.WEBHOOK_EXPECTED_NETWORK
})

describe('validateWebhookBody (unit)', () => {
  it('accepts a plain object payload', () => {
    expect(validateWebhookBody({ eventId: 'e1' }, undefined)).toEqual({ ok: true })
  })

  it('rejects a JSON array payload', () => {
    expect(validateWebhookBody([{ eventId: 'e1' }], undefined).ok).toBe(false)
  })

  it('rejects null and primitive payloads', () => {
    expect(validateWebhookBody(null, undefined).ok).toBe(false)
    expect(validateWebhookBody('just a string', undefined).ok).toBe(false)
    expect(validateWebhookBody(42, undefined).ok).toBe(false)
    expect(validateWebhookBody(true, undefined).ok).toBe(false)
  })

  it('accepts a payload without a network field when a network is expected', () => {
    expect(validateWebhookBody({ eventId: 'e1' }, TESTNET)).toEqual({ ok: true })
  })

  it('accepts a payload on the expected network', () => {
    expect(validateWebhookBody({ eventId: 'e1', network: TESTNET }, TESTNET)).toEqual({ ok: true })
  })

  it('rejects a wrong-network payload', () => {
    const result = validateWebhookBody({ eventId: 'e1', network: MAINNET }, TESTNET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Webhook event not from the expected network')
  })

  it('honours the network_passphrase and networkPassphrase aliases', () => {
    expect(validateWebhookBody({ network_passphrase: TESTNET }, TESTNET).ok).toBe(true)
    expect(validateWebhookBody({ networkPassphrase: MAINNET }, TESTNET).ok).toBe(false)
  })

  it('accepts any network when no network is expected (no invariant configured)', () => {
    expect(validateWebhookBody({ network: MAINNET }, undefined).ok).toBe(true)
  })
})

describe('webhookVerify — payload boundary', () => {
  it('accepts a valid object payload', async () => {
    const body = JSON.stringify({ eventId: 'e1', eventType: 'vault_created' })
    const res = await send(body)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('rejects an array payload with 400', async () => {
    const body = JSON.stringify([{ eventId: 'e1' }])
    const res = await send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Webhook payload must be a JSON object')
  })

  it('rejects a primitive payload with 400', async () => {
    const res = await send('"just-a-string"')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Webhook payload must be a JSON object')
  })

  it('rejects a wrong-network payload with 400 when a network is pinned', async () => {
    process.env.SOROBAN_NETWORK_PASSPHRASE = TESTNET

    const body = JSON.stringify({ eventId: 'e1', network: MAINNET })
    const res = await send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Webhook event not from the expected network')
  })

  it('accepts a same-network payload when a network is pinned', async () => {
    process.env.SOROBAN_NETWORK_PASSPHRASE = TESTNET

    const body = JSON.stringify({ eventId: 'e1', network: TESTNET })
    const res = await send(body)
    expect(res.status).toBe(200)
  })

  it('accepts a network-less payload even when a network is pinned (legacy clients)', async () => {
    process.env.SOROBAN_NETWORK_PASSPHRASE = TESTNET

    const body = JSON.stringify({ eventId: 'e1' })
    const res = await send(body)
    expect(res.status).toBe(200)
  })

  it('does not consume the nonce when the body is malformed (retry with same nonce works)', async () => {
    // A malformed (non-object) body must not burn the nonce…
    const timestamp = Date.now()
    const nonce = 'nonce-malformed-retry'

    const badBody = JSON.stringify([1, 2, 3])
    const badRes = await send(badBody, { timestamp, nonce })
    expect(badRes.status).toBe(400)

    // …so a corrected object with the same nonce/timestamp is accepted.
    const goodBody = JSON.stringify({ eventId: 'e1' })
    const goodRes = await send(goodBody, { timestamp, nonce })
    expect(goodRes.status).toBe(200)
  })

  it('keeps rejecting a replay even after a malformed-body 400 with a different nonce', async () => {
    // Sanity anchor that verification failures leave nonces usable once.
    const timestamp = Date.now()
    const successfulNonce = 'nonce-once-replay-target'
    expect((await send(JSON.stringify({ a: 1 }), { timestamp, nonce: successfulNonce })).status).toBe(200)

    // A second request with the SAME nonce is rejected as a replay.
    const replayRes = await send(JSON.stringify({ a: 1 }), { timestamp, nonce: successfulNonce })
    expect(replayRes.status).toBe(401)
    expect(replayRes.body.error).toBe('Replayed webhook request')
  })

  it('rejects a tampered body with 401', async () => {
    const timestamp = Date.now()
    const nonce = `nonce-tamper-${Math.random()}`
    const original = JSON.stringify({ amount: '1000' })
    const signature = sign('test-secret', timestamp, nonce, original)

    const tampered = JSON.stringify({ amount: '999999' })
    const res = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp.toString())
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(tampered)

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid webhook signature')
  })

  it('rejects a request outside the allowed time window with 401', async () => {
    const res = await send(JSON.stringify({ a: 1 }), { timestamp: Date.now() - 600_000 })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Webhook request outside of allowed time window')
  })
})

describe('getExpectedInboundNetwork', () => {
  it('prefers WEBHOOK_EXPECTED_NETWORK over SOROBAN_NETWORK_PASSPHRASE', () => {
    process.env.WEBHOOK_EXPECTED_NETWORK = MAINNET
    process.env.SOROBAN_NETWORK_PASSPHRASE = TESTNET
    expect(getExpectedInboundNetwork()).toBe(MAINNET)
  })

  it('falls back to SOROBAN_NETWORK_PASSPHRASE', () => {
    process.env.SOROBAN_NETWORK_PASSPHRASE = TESTNET
    expect(getExpectedInboundNetwork()).toBe(TESTNET)
  })

  it('returns undefined when no network is configured', () => {
    expect(getExpectedInboundNetwork()).toBeUndefined()
  })
})
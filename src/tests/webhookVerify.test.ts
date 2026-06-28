import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { webhookVerify } from '../middleware/webhookVerify.js'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import crypto from 'crypto'
import { _resetEnvForTesting, getEnv } from '../config/env.js'

describe('webhookVerify', () => {
  let app: express.Application
  let testEnv: Record<string, string>

  beforeEach(() => {
    testEnv = {
      ...process.env,
      WEBHOOK_INBOUND_SECRET: 'test-secret',
      WEBHOOK_INBOUND_SKEW_MS: '300000', // 5 minutes
    }
    
    vi.stubEnv('WEBHOOK_INBOUND_SECRET', 'test-secret')
    vi.stubEnv('WEBHOOK_INBOUND_SKEW_MS', '300000')

    // Since getEnv relies on initEnv, we'll mock getEnv for this test file
    vi.mock('../config/index.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../config/index.js')>()
      return {
        ...actual,
        getEnv: () => ({
          ...actual.getEnv(),
          WEBHOOK_INBOUND_SECRET: 'test-secret',
          WEBHOOK_INBOUND_SKEW_MS: 300000,
          MAX_JSON_BODY_SIZE: '500kb',
        }),
      }
    })

    app = express()
    app.post('/webhook', webhookVerify, (req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const generateSignature = (secret: string, timestamp: number, nonce: string, body: string) => {
    const digest = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest('hex')
    return `sha256=${digest}`
  }

  it('accepts a valid request within the skew window', async () => {
    const timestamp = Date.now()
    const nonce = 'nonce-123'
    const body = JSON.stringify({ test: 'data' })
    const signature = generateSignature('test-secret', timestamp, nonce, body)

    const response = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp.toString())
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  it('rejects a request with missing headers', async () => {
    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ test: 'data' }))

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Missing required webhook headers' })
  })

  it('rejects a request outside the skew window', async () => {
    const timestamp = Date.now() - 600000 // 10 minutes ago
    const nonce = 'nonce-124'
    const body = JSON.stringify({ test: 'data' })
    const signature = generateSignature('test-secret', timestamp, nonce, body)

    const response = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp.toString())
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Webhook request outside of allowed time window' })
  })

  it('rejects a request with an invalid signature', async () => {
    const timestamp = Date.now()
    const nonce = 'nonce-125'
    const body = JSON.stringify({ test: 'data' })
    const signature = generateSignature('wrong-secret', timestamp, nonce, body)

    const response = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp.toString())
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Invalid webhook signature' })
  })

  it('rejects a request with a tampered body', async () => {
    const timestamp = Date.now()
    const nonce = 'nonce-126'
    const body = JSON.stringify({ test: 'data' })
    const signature = generateSignature('test-secret', timestamp, nonce, body)

    const tamperedBody = JSON.stringify({ test: 'tampered' })

    const response = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp.toString())
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(tamperedBody)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Invalid webhook signature' })
  })

  it('rejects a replayed request with the same nonce', async () => {
    const timestamp = Date.now()
    const nonce = 'nonce-127'
    const body = JSON.stringify({ test: 'data' })
    const signature = generateSignature('test-secret', timestamp, nonce, body)

    const firstResponse = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp.toString())
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)

    expect(firstResponse.status).toBe(200)

    const secondResponse = await request(app)
      .post('/webhook')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp.toString())
      .set('x-webhook-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body)

    expect(secondResponse.status).toBe(401)
    expect(secondResponse.body).toEqual({ error: 'Replayed webhook request' })
  })
})

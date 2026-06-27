import { afterEach, describe, expect, it } from 'bun:test'
import express from 'express'
import request from 'supertest'
import { privacyLogger, redact, REDACTED } from '../middleware/privacy-logger.js'

describe('privacy logger allowlist mode', () => {
  const originalLog = console.log

  afterEach(() => {
    console.log = originalLog
  })

  it('redacts unknown fields by default in allowlist mode', () => {
    const output = redact(
      {
        requestId: 'req-123',
        status: 'active',
        webhookSigningSecret: 'whsec_live_secret',
      },
      { allowlistMode: true },
    )

    expect(output).toEqual({
      requestId: 'req-123',
      status: 'active',
      webhookSigningSecret: REDACTED,
    })
  })

  it('keeps denylist redactions active even for allowlisted keys', () => {
    const output = redact(
      {
        token: 'plain-token',
        status: 'active',
      },
      {
        allowlistMode: true,
        allowedKeys: ['token', 'status'],
      },
    )

    expect(output).toEqual({
      token: REDACTED,
      status: 'active',
    })
  })

  it('recursively redacts nested unknown fields and nested denylisted secrets', () => {
    const output = redact(
      {
        metadata: {
          status: 'queued',
          webauthnChallenge: 'challenge-secret',
          nested: {
            token: 'nested-token',
            status: 'retrying',
          },
        },
      },
      {
        allowlistMode: true,
        allowedKeys: ['metadata', 'nested', 'status'],
      },
    )

    expect(output).toEqual({
      metadata: {
        status: 'queued',
        webauthnChallenge: REDACTED,
        nested: {
          token: REDACTED,
          status: 'retrying',
        },
      },
    })
  })

  it('logs only allowlisted request fields while preserving operational fields', async () => {
    const lines: string[] = []
    console.log = (line?: unknown) => {
      lines.push(String(line))
    }

    const app = express()
    app.use(express.json())
    app.use(privacyLogger)
    app.post('/hook', (_req, res) => {
      res.status(202).json({ ok: true })
    })

    await request(app)
      .post('/hook?requestId=req-123&webhookSecret=query-secret')
      .set('Authorization', 'Bearer secret-token')
      .set('User-Agent', 'allowlist-test')
      .send({
        requestId: 'req-123',
        status: 'pending',
        webhookSigningSecret: 'body-secret',
        details: { token: 'nested-token' },
      })
      .expect(202)

    expect(lines).toHaveLength(1)
    const logLine = JSON.parse(lines[0])

    expect(logLine.method).toBe('POST')
    expect(logLine.url).toContain('/hook')
    expect(logLine.status).toBe(202)
    expect(logLine.body).toEqual({
      requestId: 'req-123',
      status: 'pending',
      webhookSigningSecret: REDACTED,
      details: REDACTED,
    })
    expect(logLine.query).toEqual({
      requestId: 'req-123',
      webhookSecret: REDACTED,
    })
    expect(logLine.headers.authorization).toBe(REDACTED)
    expect(logLine.headers['user-agent']).toBe('allowlist-test')
  })
})

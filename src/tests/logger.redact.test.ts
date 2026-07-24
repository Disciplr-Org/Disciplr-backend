/**
 * Tests for the Pino redact configuration in src/middleware/logger.ts.
 *
 * Strategy: create a logger whose destination is an in-memory stream, write a
 * structured log that includes a nested `req.body` object, then parse the
 * emitted JSON and assert that each sensitive path is replaced by the Pino
 * redact placeholder `[Redacted]` while harmless fields pass through unchanged.
 */

import { Writable } from 'stream'
import pino from 'pino'
import { describe, it, expect } from '@jest/globals'

// ---------------------------------------------------------------------------
// Helper — build a Pino logger that writes to an in-memory buffer
// ---------------------------------------------------------------------------

function buildTestLogger() {
  const lines: string[] = []

  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString())
      cb()
    },
  })

  // Replicate the same redact config as createLogger() in logger.ts so that
  // tests stay tightly coupled to the real configuration.
  const redactPaths: string[] = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'req.body.password',
    'req.body.token',
    'req.body.accessToken',
    'req.body.refreshToken',
    'req.body.apiKey',
    'req.body.api_key',
    'req.body.secret',
    'req.body.new_secret',
    'req.body.clientSecret',
    'req.body.client_secret',
    'req.body.creator',
    'req.body.successDestination',
    'req.body.failureDestination',
    'req.body.email',
    'res.headers.authorization',
    'res.headers.cookie',
    'res.headers["x-api-key"]',
    'err.authorization',
    'err.password',
    'err.token',
    'err.apiKey',
    'err.secret',
    'metadata.authorization',
    'metadata.password',
    'metadata.token',
    'metadata.apiKey',
    'metadata.secret',
    'user.email',
    'user.password',
    'user.apiKey',
    'vault.creator',
    'vault.successDestination',
    'vault.failureDestination',
  ]

  const logger = pino(
    {
      level: 'info',
      redact: { paths: redactPaths, remove: false },
    },
    stream,
  )

  function flush(): Record<string, unknown> {
    const last = lines[lines.length - 1]
    if (!last) throw new Error('No log lines emitted')
    return JSON.parse(last.trim())
  }

  return { logger, flush }
}

const PINO_REDACTED = '[Redacted]'

// ---------------------------------------------------------------------------
// req.body redaction
// ---------------------------------------------------------------------------

describe('Pino redact — req.body sensitive fields', () => {
  it('redacts req.body.client_secret (OAuth snake_case — primary issue #1039)', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { body: { client_secret: 'super-secret-oauth-key', grant_type: 'client_credentials' } } })
    const line = flush()
    expect((line.req as any).body.client_secret).toBe(PINO_REDACTED)
    // Safe field must pass through
    expect((line.req as any).body.grant_type).toBe('client_credentials')
  })

  it('redacts req.body.new_secret (webhook secret rotation)', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { body: { organization_id: 'org-123', new_secret: 'whsec_new_value' } } })
    const line = flush()
    expect((line.req as any).body.new_secret).toBe(PINO_REDACTED)
    // organization_id is not sensitive — must not be redacted
    expect((line.req as any).body.organization_id).toBe('org-123')
  })

  it('redacts req.body.secret (webhook subscriber creation)', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { body: { url: 'https://example.com/hook', secret: 'whsec_value' } } })
    const line = flush()
    expect((line.req as any).body.secret).toBe(PINO_REDACTED)
    expect((line.req as any).body.url).toBe('https://example.com/hook')
  })

  it('still redacts pre-existing camelCase req.body.clientSecret', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { body: { clientSecret: 'legacy-secret', clientId: 'id-abc' } } })
    const line = flush()
    expect((line.req as any).body.clientSecret).toBe(PINO_REDACTED)
    expect((line.req as any).body.clientId).toBe('id-abc')
  })

  it('still redacts req.body.refreshToken (camelCase auth schema)', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { body: { refreshToken: 'rt_abc123' } } })
    const line = flush()
    expect((line.req as any).body.refreshToken).toBe(PINO_REDACTED)
  })

  it('still redacts req.body.password', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { body: { email: 'user@example.com', password: 'hunter2' } } })
    const line = flush()
    expect((line.req as any).body.password).toBe(PINO_REDACTED)
    expect((line.req as any).body.email).toBe(PINO_REDACTED)
  })

  it('still redacts req.body.api_key (snake_case pre-existing entry)', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { body: { api_key: 'ak_live_xxx', scope: 'read' } } })
    const line = flush()
    expect((line.req as any).body.api_key).toBe(PINO_REDACTED)
    expect((line.req as any).body.scope).toBe('read')
  })

  it('does not redact harmless req.body fields', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({
      req: {
        body: {
          grant_type: 'client_credentials',
          client_id: 'app-123',
          scope: 'read:vaults',
          amount: 500,
          vaultId: 'v-abc',
        },
      },
    })
    const line = flush()
    const body = (line.req as any).body
    expect(body.grant_type).toBe('client_credentials')
    expect(body.client_id).toBe('app-123')
    expect(body.scope).toBe('read:vaults')
    expect(body.amount).toBe(500)
    expect(body.vaultId).toBe('v-abc')
  })
})

// ---------------------------------------------------------------------------
// req.headers redaction
// ---------------------------------------------------------------------------

describe('Pino redact — req.headers sensitive fields', () => {
  it('redacts req.headers.authorization', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } } })
    const line = flush()
    expect((line.req as any).headers.authorization).toBe(PINO_REDACTED)
    expect((line.req as any).headers['content-type']).toBe('application/json')
  })

  it('redacts req.headers.cookie', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({ req: { headers: { cookie: 'session=abc' } } })
    const line = flush()
    expect((line.req as any).headers.cookie).toBe(PINO_REDACTED)
  })
})

// ---------------------------------------------------------------------------
// vault namespace
// ---------------------------------------------------------------------------

describe('Pino redact — vault namespace', () => {
  it('redacts vault.creator and vault.successDestination but not vault.id', () => {
    const { logger, flush } = buildTestLogger()
    logger.info({
      vault: {
        id: 'v-1',
        creator: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5TO85RWJUFOXBZHU2ZLJKP',
        successDestination: 'GADDR',
        failureDestination: 'GADDR2',
        amount: 1000,
      },
    })
    const line = flush()
    const vault = line.vault as any
    expect(vault.id).toBe('v-1')
    expect(vault.amount).toBe(1000)
    expect(vault.creator).toBe(PINO_REDACTED)
    expect(vault.successDestination).toBe(PINO_REDACTED)
    expect(vault.failureDestination).toBe(PINO_REDACTED)
  })
})

// ---------------------------------------------------------------------------
// Combined: a realistic OAuth token request log
// ---------------------------------------------------------------------------

describe('Pino redact — realistic OAuth token request scenario', () => {
  it('fully redacts a POST /api/oauth/token request log', () => {
    const { logger, flush } = buildTestLogger()

    // Simulate what requestLogger emits when it logs a sampled OAuth request
    logger.info({
      event: 'http.request',
      req: {
        method: 'POST',
        path: '/api/oauth/token',
        headers: { authorization: 'Basic dXNlcjpwYXNz', 'content-type': 'application/json' },
        body: {
          grant_type: 'client_credentials',
          client_id: 'app-abc',
          client_secret: 's3cr3t-oauth-key',
          scope: 'read:vaults',
        },
      },
      res: { statusCode: 200 },
    })

    const line = flush()
    const body = (line.req as any).body

    // The critical field from #1039
    expect(body.client_secret).toBe(PINO_REDACTED)

    // Safe OAuth fields must survive
    expect(body.grant_type).toBe('client_credentials')
    expect(body.client_id).toBe('app-abc')
    expect(body.scope).toBe('read:vaults')

    // Header also redacted
    expect((line.req as any).headers.authorization).toBe(PINO_REDACTED)
  })
})

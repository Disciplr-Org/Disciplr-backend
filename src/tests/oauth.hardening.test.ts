import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import express from 'express'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ApiScope } from '../types/auth.js'

// ---------------------------------------------------------------------------
// Mock getEnv so OAuth modules read JWT_SECRET from the mock rather than
// requiring initEnv(). Without DATABASE_URL the pg.Pool stays null, keeping
// the ApiKey repository on its in-memory fallback — exactly as the existing
// oauth.clientCredentials suite runs.
// ---------------------------------------------------------------------------
jest.unstable_mockModule('../config/index.js', () => ({
  getEnv: () => ({
    JWT_SECRET: 'test-jwt-secret-0123456789',
    STELLAR_NETWORK_PASSPHRASE: process.env.OAUTH_TEST_NETWORK_PASSPHRASE,
  }),
  initEnv: () => {},
  _resetEnvForTesting: () => {},
}))

const { oauthRouter, resolveTokenTtlSeconds } = await import('../routes/oauth.js')
const { authenticateOAuthBearer } = await import('../middleware/oauthBearer.js')
const { createApiKey, resetApiKeysTable } = await import('../services/apiKeys.js')

const JWT_SECRET = 'test-jwt-secret-0123456789'
const SAVED_TTL = process.env.OAUTH_TOKEN_TTL_SECONDS
const SAVED_NETWORK = process.env.OAUTH_TEST_NETWORK_PASSPHRASE

let baseUrl: string
let server: Server

beforeEach(async () => {
  await resetApiKeysTable()

  const app = express()
  app.use(express.json())
  app.use('/api/oauth', oauthRouter)
  app.get('/protected', authenticateOAuthBearer([ApiScope.ReadVaults]), (_req, res) => {
    res.json({ ok: true })
  })

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  if (SAVED_TTL === undefined) {
    delete process.env.OAUTH_TOKEN_TTL_SECONDS
  } else {
    process.env.OAUTH_TOKEN_TTL_SECONDS = SAVED_TTL
  }
  if (SAVED_NETWORK === undefined) {
    delete process.env.OAUTH_TEST_NETWORK_PASSPHRASE
  } else {
    process.env.OAUTH_TEST_NETWORK_PASSPHRASE = SAVED_NETWORK
  }
})

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const get = (path: string, token: string) =>
  fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })

const makeKey = async (scopes: ApiScope[] = [ApiScope.ReadVaults]) => {
  const { apiKey, record } = await createApiKey({ label: 'harden-test', scopes })
  return { apiKey, record }
}

const issue = async (scopes: ApiScope[] = [ApiScope.ReadVaults]) => {
  const { apiKey, record } = await makeKey(scopes)
  const res = await post('/api/oauth/token', {
    grant_type: 'client_credentials',
    client_id: record.id,
    client_secret: apiKey,
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).access_token as string
}

// ---------------------------------------------------------------------------
// Access-token TTL clamping
// ---------------------------------------------------------------------------

describe('resolveTokenTtlSeconds', () => {
  it('defaults to 3600 when unset', () => {
    delete process.env.OAUTH_TOKEN_TTL_SECONDS
    expect(resolveTokenTtlSeconds()).toBe(3600)
  })

  it('honors an in-window integer value', () => {
    process.env.OAUTH_TOKEN_TTL_SECONDS = '300'
    expect(resolveTokenTtlSeconds()).toBe(300)
    process.env.OAUTH_TOKEN_TTL_SECONDS = '43200'
    expect(resolveTokenTtlSeconds()).toBe(43200)
    process.env.OAUTH_TOKEN_TTL_SECONDS = '60'
    expect(resolveTokenTtlSeconds()).toBe(60)
  })

  it('clamps below-minimum, above-maximum, non-integer, and NaN values to default', () => {
    for (const raw of ['0', '30', '59', '999999', '99999999999999', '12.5', 'abc', '-1', '3600.0']) {
      process.env.OAUTH_TOKEN_TTL_SECONDS = raw
      expect(resolveTokenTtlSeconds()).toBe(3600)
    }
  })
})

// ---------------------------------------------------------------------------
// Request boundary validation → RFC 6749 invalid_request
// ---------------------------------------------------------------------------

describe('POST /api/oauth/token – request boundary (invalid_request)', () => {
  it('rejects a non-UUID client_id', async () => {
    const { apiKey } = await makeKey()
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'definitely-not-a-uuid',
      client_secret: apiKey,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_request')
  })

  it('rejects an empty client_secret', async () => {
    const { record } = await makeKey()
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: '',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_request')
  })

  it('rejects an oversized client_secret', async () => {
    const { record } = await makeKey()
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: `dsk_${'A'.repeat(1080)}`,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_request')
  })

  it('rejects an oversized scope string', async () => {
    const { apiKey, record } = await makeKey()
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
      scope: 'x'.repeat(300),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_request')
  })
})

// ---------------------------------------------------------------------------
// client_id ↔ secret binding
// ---------------------------------------------------------------------------

describe('POST /api/oauth/token – client identity binding', () => {
  it('validates the secret against the REAL key even when client_id is forged', async () => {
    // Presenting a valid key with a random but different client_id must fail.
    const { apiKey } = await makeKey()
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: randomUUID(),
      client_secret: apiKey,
    })
    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toBe('invalid_client')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('mints a token whose sub and client_id both equal the bound key id', async () => {
    const { apiKey, record } = await makeKey()
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const decoded = jwt.verify(body.access_token, JWT_SECRET) as any
    expect(decoded.sub).toBe(record.id)
    expect(decoded.client_id).toBe(record.id)
  })

  it('rejects a secret that belongs to a different key presented with the target id', async () => {
    const recordA = await makeKey()
    const keyB = await makeKey()
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: recordA.record.id,
      client_secret: keyB.apiKey,
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error).toBe('invalid_client')
  })
})

// ---------------------------------------------------------------------------
// Scope handling
// ---------------------------------------------------------------------------

describe('POST /api/oauth/token – scope edge cases', () => {
  it('rejects an empty scope list with invalid_scope', async () => {
    const { apiKey, record } = await makeKey([ApiScope.ReadVaults, ApiScope.ReadAnalytics])
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
      scope: '   ',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_scope')
  })

  it('deduplicates repeated scopes in the minted token', async () => {
    const { apiKey, record } = await makeKey([ApiScope.ReadVaults, ApiScope.ReadAnalytics])
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
      scope: 'read:vaults read:vaults read:analytics read:vaults',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const scopes = String(body.scope).split(' ')
    expect(scopes).toEqual(['read:vaults', 'read:analytics'])
    const decoded = jwt.verify(body.access_token, JWT_SECRET) as any
    expect(decoded.scope.split(' ')).toEqual(['read:vaults', 'read:analytics'])
  })
})

// ---------------------------------------------------------------------------
// JWT hardening claims
// ---------------------------------------------------------------------------

describe('POST /api/oauth/token – issued token claims', () => {
  it('includes a unique jti claim on every access token', async () => {
    const tokenA = await issue()
    const tokenB = await issue()
    const a = jwt.verify(tokenA, JWT_SECRET) as any
    const b = jwt.verify(tokenB, JWT_SECRET) as any
    expect(typeof a.jti).toBe('string')
    expect(a.jti).toBeTruthy()
    expect(a.jti).not.toBe(b.jti)
  })
})

// ---------------------------------------------------------------------------
// Cross-network replay guard
// ---------------------------------------------------------------------------

describe('authenticateOAuthBearer – network binding', () => {
  it('rejects tokens carrying a net claim that does not match this deployment', async () => {
    const token = jwt.sign(
      { sub: 'x', client_id: 'x', scope: 'read:vaults', iss: 'disciplr', aud: 'disciplr-api', net: 'testnet-passphrase' },
      JWT_SECRET,
      { expiresIn: 3600 },
    )
    const res = await get('/protected', token)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error).toMatch(/different network/i)
  })

  it('accepts tokens without a net claim (pre-existing issuance)', async () => {
    const token = await issue()
    const res = await get('/protected', token)
    expect(res.status).toBe(200)
  })

  it('accepts tokens whose net claim matches the deployment network', async () => {
    process.env.OAUTH_TEST_NETWORK_PASSPHRASE = 'testnet-passphrase'
    const token = jwt.sign(
      { sub: 'x', client_id: 'x', scope: 'read:vaults', iss: 'disciplr', aud: 'disciplr-api', net: 'testnet-passphrase' },
      JWT_SECRET,
      { expiresIn: 3600 },
    )
    const res = await get('/protected', token)
    expect(res.status).toBe(200)
  })
})
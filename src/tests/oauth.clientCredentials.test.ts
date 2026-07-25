import express from 'express'
import jwt from 'jsonwebtoken'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { oauthRouter } from '../../src/routes/oauth.js'
import { authenticateOAuthBearer } from '../../src/middleware/oauthBearer.js'
import { createApiKey, resetApiKeysTable, revokeApiKey } from '../../src/services/apiKeys.js'
import { ApiScope } from '../../src/types/auth.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

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
  app.get('/analytics', authenticateOAuthBearer([ApiScope.ReadAnalytics]), (_req, res) => {
    res.json({ ok: true })
  })
  app.get('/open', authenticateOAuthBearer(), (_req, res) => {
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
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const get = (path: string, token: string) =>
  fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })

// ---------------------------------------------------------------------------
// Valid issuance
// ---------------------------------------------------------------------------

describe('POST /api/oauth/token – valid issuance', () => {
  it('returns a bearer token with all client scopes when no scope requested', async () => {
    const { apiKey, record } = await createApiKey({
      label: 'test',
      scopes: [ApiScope.ReadVaults, ApiScope.ReadAnalytics],
    })

    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.token_type).toBe('Bearer')
    expect(typeof body.access_token).toBe('string')
    expect(body.expires_in).toBeGreaterThan(0)

    const decoded = jwt.verify(body.access_token, JWT_SECRET) as any
    expect(decoded.iss).toBe('disciplr')
    expect(decoded.aud).toBe('disciplr-api')
    expect(decoded.sub).toBe(record.id)
    expect(decoded.scope).toContain('read:vaults')
    expect(decoded.scope).toContain('read:analytics')
  })

  it('sets Cache-Control: no-store and Pragma: no-cache', async () => {
    const { apiKey, record } = await createApiKey({ label: 'test', scopes: [ApiScope.ReadVaults] })

    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })

  it('includes org_id in token when key has orgId', async () => {
    const { apiKey, record } = await createApiKey({
      label: 'org-key',
      scopes: [ApiScope.ReadVaults],
      orgId: 'org-abc',
    })

    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    const decoded = jwt.verify(body.access_token, JWT_SECRET) as any
    expect(decoded.org_id).toBe('org-abc')
  })
})

// ---------------------------------------------------------------------------
// Scope narrowing
// ---------------------------------------------------------------------------

describe('POST /api/oauth/token – scope narrowing', () => {
  it('narrows to requested subset of client scopes', async () => {
    const { apiKey, record } = await createApiKey({
      label: 'wide',
      scopes: [ApiScope.ReadVaults, ApiScope.ReadAnalytics],
    })

    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
      scope: 'read:vaults',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.scope).toBe('read:vaults')
    const decoded = jwt.verify(body.access_token, JWT_SECRET) as any
    expect(decoded.scope).toBe('read:vaults')
    expect(decoded.scope).not.toContain('read:analytics')
  })

  it('rejects scope that exceeds client grants – RFC 6749 invalid_scope', async () => {
    const { apiKey, record } = await createApiKey({
      label: 'narrow',
      scopes: [ApiScope.ReadVaults],
    })

    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
      scope: 'read:vaults read:analytics',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toBe('invalid_scope')
    expect(body.error_description).toContain('read:analytics')
  })
})

// ---------------------------------------------------------------------------
// Invalid client
// ---------------------------------------------------------------------------

describe('POST /api/oauth/token – invalid client', () => {
  it('returns invalid_client for wrong secret', async () => {
    const { record } = await createApiKey({ label: 'test', scopes: [ApiScope.ReadVaults] })

    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: `dsk_${record.id}.wrongsecret`,
    })

    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toBe('invalid_client')
  })

  it('returns invalid_client for revoked key', async () => {
    const { apiKey, record } = await createApiKey({
      label: 'test',
      scopes: [ApiScope.ReadVaults],
      userId: 'test-user',
    } as any)
    await revokeApiKey(record.id, 'test-user')

    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })

    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toBe('invalid_client')
  })

  it('returns invalid_request when client_id or client_secret missing', async () => {
    const res1 = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_secret: 'dsk_foo.bar',
    })
    expect(res1.status).toBe(400)
    expect(((await res1.json()) as any).error).toBe('invalid_request')

    const res2 = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'some-id',
    })
    expect(res2.status).toBe(400)
    expect(((await res2.json()) as any).error).toBe('invalid_request')
  })
})

// ---------------------------------------------------------------------------
// grant_type validation
// ---------------------------------------------------------------------------

describe('POST /api/oauth/token – unsupported_grant_type', () => {
  it('rejects unsupported grant types', async () => {
    const res = await post('/api/oauth/token', {
      grant_type: 'password',
      client_id: 'x',
      client_secret: 'y',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toBe('unsupported_grant_type')
  })

  it('rejects missing grant_type', async () => {
    const res = await post('/api/oauth/token', { client_id: 'x', client_secret: 'y' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('unsupported_grant_type')
  })
})

// ---------------------------------------------------------------------------
// Bearer middleware – oauthBearer
// ---------------------------------------------------------------------------

describe('authenticateOAuthBearer middleware', () => {
  const issueToken = async (scopes: ApiScope[]): Promise<string> => {
    const { apiKey, record } = await createApiKey({ label: 'mw-test', scopes })
    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })
    return ((await res.json()) as any).access_token as string
  }

  it('allows request with valid token and matching scope', async () => {
    const token = await issueToken([ApiScope.ReadVaults])
    const res = await get('/protected', token)
    expect(res.status).toBe(200)
  })

  it('rejects request with missing Authorization header', async () => {
    const res = await fetch(`${baseUrl}/protected`)
    expect(res.status).toBe(401)
  })

  it('rejects request with expired token', async () => {
    const expired = jwt.sign(
      { sub: 'x', client_id: 'x', scope: 'read:vaults', iss: 'disciplr', aud: 'disciplr-api' },
      JWT_SECRET,
      { expiresIn: -1 },
    )
    const res = await get('/protected', expired)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error).toMatch(/expired/i)
  })

  it('rejects token signed with wrong secret', async () => {
    const token = jwt.sign(
      { sub: 'x', client_id: 'x', scope: 'read:vaults', iss: 'disciplr', aud: 'disciplr-api' },
      'wrong-secret',
      { expiresIn: 3600 },
    )
    const res = await get('/protected', token)
    expect(res.status).toBe(401)
  })

  it('rejects token with wrong issuer', async () => {
    const token = jwt.sign(
      { sub: 'x', client_id: 'x', scope: 'read:vaults', iss: 'not-disciplr', aud: 'disciplr-api' },
      JWT_SECRET,
      { expiresIn: 3600 },
    )
    const res = await get('/protected', token)
    expect(res.status).toBe(401)
  })

  it('rejects token with insufficient scope', async () => {
    const token = await issueToken([ApiScope.ReadVaults])
    const res = await get('/analytics', token)
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error).toMatch(/missing scope/i)
  })

  it('allows token with superset of required scopes', async () => {
    const token = await issueToken([ApiScope.ReadVaults, ApiScope.ReadAnalytics])
    const res = await get('/analytics', token)
    expect(res.status).toBe(200)
  })

  it('allows any valid token on no-scope-requirement route', async () => {
    const token = await issueToken([ApiScope.ReadVaults])
    const res = await get('/open', token)
    expect(res.status).toBe(200)
  })

  it('attaches oauthToken to req with correct fields', async () => {
    const token = await issueToken([ApiScope.ReadVaults])
    const decoded = jwt.verify(token, JWT_SECRET) as any
    expect(decoded.sub).toBeDefined()
    expect(decoded.scope).toBe('read:vaults')
    expect(decoded.iss).toBe('disciplr')
    expect(decoded.aud).toBe('disciplr-api')
  })
})

// ---------------------------------------------------------------------------
// Token expiry structure
// ---------------------------------------------------------------------------

describe('Token expiry', () => {
  it('token exp is approximately now + TOKEN_TTL_SECONDS', async () => {
    const { apiKey, record } = await createApiKey({ label: 'exp-test', scopes: [ApiScope.ReadVaults] })
    const before = Math.floor(Date.now() / 1000)

    const res = await post('/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })
    const body = await res.json() as any
    const decoded = jwt.verify(body.access_token, JWT_SECRET) as any
    const after = Math.floor(Date.now() / 1000)

    expect(decoded.exp).toBeGreaterThanOrEqual(before + body.expires_in - 2)
    expect(decoded.exp).toBeLessThanOrEqual(after + body.expires_in + 2)
  })
})

// ---------------------------------------------------------------------------
// RFC 6749 error response shape
// ---------------------------------------------------------------------------

describe('RFC 6749 error response shape', () => {
  it('all error responses include error + error_description and no-store headers', async () => {
    const cases = await Promise.all([
      post('/api/oauth/token', { grant_type: 'password' }),
      post('/api/oauth/token', { grant_type: 'client_credentials' }),
      post('/api/oauth/token', {
        grant_type: 'client_credentials',
        client_id: 'x',
        client_secret: 'dsk_bad.bad',
      }),
    ])

    for (const res of cases) {
      const body = await res.json() as any
      expect(typeof body.error).toBe('string')
      expect(typeof body.error_description).toBe('string')
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })
})

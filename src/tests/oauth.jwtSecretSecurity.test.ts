import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import express from 'express'
import jwt from 'jsonwebtoken'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ApiScope } from '../types/auth.js'

let mockJwtSecret = 'test-jwt-secret-0123456789'
let mockNodeEnv = 'test'

jest.unstable_mockModule('../config/index.js', () => ({
  getEnv: () => ({
    JWT_SECRET: mockJwtSecret,
    NODE_ENV: mockNodeEnv,
  }),
  initEnv: () => {},
  _resetEnvForTesting: () => {},
}))

const { oauthRouter, getOAuthJwtSecret } = await import('../routes/oauth.js')
const { createApiKey, resetApiKeysTable } = await import('../services/apiKeys.js')

let baseUrl: string
let server: Server
const savedNodeEnv = process.env.NODE_ENV
const savedJwtSecret = process.env.JWT_SECRET

beforeEach(async () => {
  await resetApiKeysTable()
  mockJwtSecret = 'test-jwt-secret-0123456789'
  mockNodeEnv = 'test'
  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET = 'test-jwt-secret-0123456789'

  const app = express()
  app.use(express.json())
  app.use('/api/oauth', oauthRouter)

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
  if (savedNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = savedNodeEnv
  }
  if (savedJwtSecret === undefined) {
    delete process.env.JWT_SECRET
  } else {
    process.env.JWT_SECRET = savedJwtSecret
  }
})

const postToken = (body: unknown) =>
  fetch(`${baseUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('OAuth token endpoint JWT_SECRET security & fail-closed in production (#1652)', () => {
  it('fails closed with HTTP 500 server_error in production if JWT_SECRET equals sentinel default', async () => {
    mockNodeEnv = 'production'
    mockJwtSecret = 'change-me-in-production-long-secret'
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = 'change-me-in-production-long-secret'

    const { apiKey, record } = await createApiKey({
      label: 'prod-test',
      scopes: [ApiScope.ReadVaults],
    })

    const res = await postToken({
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as any
    expect(body.error).toBe('server_error')
    expect(body.error_description).toContain('insecure secret configuration')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })

  it('fails closed with HTTP 500 server_error in production if JWT_SECRET equals legacy insecure default', async () => {
    mockNodeEnv = 'production'
    mockJwtSecret = 'change-me-in-production'
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = 'change-me-in-production'

    const { apiKey, record } = await createApiKey({
      label: 'prod-test-legacy',
      scopes: [ApiScope.ReadVaults],
    })

    const res = await postToken({
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as any
    expect(body.error).toBe('server_error')
  })

  it('fails closed with HTTP 500 server_error in production if JWT_SECRET is empty', async () => {
    mockNodeEnv = 'production'
    mockJwtSecret = ''
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = ''

    const { apiKey, record } = await createApiKey({
      label: 'prod-test-empty',
      scopes: [ApiScope.ReadVaults],
    })

    const res = await postToken({
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as any
    expect(body.error).toBe('server_error')
  })

  it('successfully issues tokens signed with getEnv().JWT_SECRET when configured securely in production', async () => {
    const strongProdSecret = 'super-strong-production-secret-9876543210'
    mockNodeEnv = 'production'
    mockJwtSecret = strongProdSecret
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = strongProdSecret

    const { apiKey, record } = await createApiKey({
      label: 'prod-test-secure',
      scopes: [ApiScope.ReadVaults],
    })

    const res = await postToken({
      grant_type: 'client_credentials',
      client_id: record.id,
      client_secret: apiKey,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.token_type).toBe('Bearer')
    expect(typeof body.access_token).toBe('string')

    const decoded = jwt.verify(body.access_token, strongProdSecret) as any
    expect(decoded.sub).toBe(record.id)
    expect(decoded.client_id).toBe(record.id)
  })

  it('getOAuthJwtSecret helper validates secrets and fails closed when insecure in production', () => {
    process.env.NODE_ENV = 'production'
    mockNodeEnv = 'production'

    mockJwtSecret = 'change-me-in-production-long-secret'
    process.env.JWT_SECRET = 'change-me-in-production-long-secret'
    expect(() => getOAuthJwtSecret()).toThrow(/insecure default/)

    mockJwtSecret = 'change-me-in-production'
    process.env.JWT_SECRET = 'change-me-in-production'
    expect(() => getOAuthJwtSecret()).toThrow(/insecure default/)

    mockJwtSecret = 'valid-secure-production-secret-12345'
    process.env.JWT_SECRET = 'valid-secure-production-secret-12345'
    expect(getOAuthJwtSecret()).toBe('valid-secure-production-secret-12345')
  })
})

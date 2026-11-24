import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import express from 'express'
import request from 'supertest'

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'user-test' } as any
    next()
  },
}))
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  apiKeyRateLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))
jest.unstable_mockModule('../middleware/stepUp.js', () => ({
  requireStepUp: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))
jest.unstable_mockModule('../db/pool.js', () => ({ getPgPool: () => null }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog: jest.fn(async () => ({ id: 'audit-1' })) }))

const { apiKeysRouter } = await import('../routes/apiKeys.js')
const { resetApiKeysTable } = await import('../services/apiKeys.js')

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/api-keys', apiKeysRouter)
  return app
}

beforeEach(async () => {
  await resetApiKeysTable()
})

describe('API key scope validation', () => {
  it('rejects unknown scope strings when creating API keys', async () => {
    const response = await request(buildApp())
      .post('/api/api-keys')
      .set('x-user-id', 'user-test')
      .send({
        label: 'bad-scopes',
        scopes: ['read:vaults', 'vault.crete'],
      })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    // ensure the invalid scope index is reported
    expect(response.body.error.fields[0].path).toBe('scopes[1]')
  })

  it('accepts valid ApiScope values', async () => {
    const response = await request(buildApp())
      .post('/api/api-keys')
      .set('x-user-id', 'user-test')
      .send({
        label: 'good-scopes',
        scopes: ['read:analytics', 'read:vaults'],
      })

    expect(response.status).toBe(201)
    expect(response.body.apiKey).toBeTruthy()
    expect(response.body.apiKeyMeta.scopes).toEqual(['read:analytics', 'read:vaults'])
  })
})

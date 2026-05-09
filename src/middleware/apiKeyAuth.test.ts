import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { authenticateApiKey } from './apiKeyAuth.js'
import { createApiKey, resetApiKeysTable } from '../services/apiKeys.js'

const buildApp = () => {
  const app = express()
  app.get(
    '/protected',
    authenticateApiKey(['read:analytics']),
    (req, res) => {
      res.status(200).json({
        ok: true,
        apiKeyId: req.apiKeyAuth?.apiKeyId ?? null,
        userId: req.apiKeyAuth?.userId ?? null,
      })
    },
  )
  return app
}

test('requires x-api-key when protecting a route', async () => {
  await resetApiKeysTable()
  const app = buildApp()

  const response = await request(app).get('/protected')

  assert.equal(response.status, 401)
  assert.equal(response.body.error, 'Missing API key. Provide x-api-key header.')
})

test('accepts a valid scoped api key', async () => {
  await resetApiKeysTable()
  const app = buildApp()
  const { apiKey, record } = await createApiKey({
    userId: 'user-scope',
    label: 'scoped key',
    scopes: ['read:analytics'],
  })

  const response = await request(app)
    .get('/protected')
    .set('x-api-key', apiKey)

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.apiKeyId, record.id)
  assert.equal(response.body.userId, 'user-scope')
})

test('rejects keys without the required scopes', async () => {
  await resetApiKeysTable()
  const app = buildApp()
  const { apiKey } = await createApiKey({
    userId: 'user-vault-only',
    label: 'vault-only key',
    scopes: ['read:vaults'],
  })

  const response = await request(app)
    .get('/protected')
    .set('x-api-key', apiKey)

  assert.equal(response.status, 403)
  assert.equal(response.body.error, 'API key does not have the required scopes.')
})

test('gives x-api-key precedence over Authorization when both are present', async () => {
  await resetApiKeysTable()
  const app = buildApp()
  const { apiKey } = await createApiKey({
    userId: 'user-good-key',
    label: 'good key',
    scopes: ['read:analytics'],
  })

  const response = await request(app)
    .get('/protected')
    .set('x-api-key', `${apiKey}-tampered`)
    .set('authorization', 'Bearer user:jwt-user')

  assert.equal(response.status, 401)
  assert.equal(response.body.error, 'API key is invalid.')
})

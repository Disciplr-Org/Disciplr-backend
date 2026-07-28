import { jest } from '@jest/globals'

jest.unstable_mockModule('../middleware/orgAuth.js', () => ({
  requireOrgAccess: jest.fn((...roles) => (req, res, next) => {
    next()
  }),
}))

import { beforeEach, describe, expect, it } from '@jest/globals'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { errorHandler } from '../middleware/errorHandler.js'
import { resetSubscribers } from '../services/webhooks.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

function makeToken(userId = 'user-1') {
  return jwt.sign({ userId, sub: userId, role: 'USER' }, JWT_SECRET)
}

let app: express.Express

beforeEach(async () => {
  resetSubscribers()

  const webhookRouter = (await import('../routes/webhooks.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/webhooks', webhookRouter)
  app.use(errorHandler)
})

describe('Webhook subscription routes', () => {
  it('creates, lists, reads, rotates, and deletes a subscription for the current org', async () => {
    const createRes = await request(app)
      .post('/api/webhooks?orgId=org-a')
      .set('Authorization', `Bearer ${makeToken('user-1')}`)
      .send({ url: 'https://example.com/webhook', events: ['vault_created'], active: true })

    expect(createRes.status).toBe(201)
    expect(createRes.body.secret).toBeDefined()
    expect(createRes.body.subscription).toMatchObject({ orgId: 'org-a', url: 'https://example.com/webhook' })
    expect(createRes.body.subscription.secret).toBeUndefined()

    const id = createRes.body.subscription.id

    const listRes = await request(app)
      .get('/api/webhooks?orgId=org-a')
      .set('Authorization', `Bearer ${makeToken('user-1')}`)

    expect(listRes.status).toBe(200)
    expect(listRes.body.subscriptions).toHaveLength(1)
    expect(listRes.body.subscriptions[0].id).toBe(id)
    expect(listRes.body.subscriptions[0].secret).toBeUndefined()

    const getRes = await request(app)
      .get(`/api/webhooks/${id}?orgId=org-a`)
      .set('Authorization', `Bearer ${makeToken('user-1')}`)

    expect(getRes.status).toBe(200)
    expect(getRes.body.subscription.id).toBe(id)
    expect(getRes.body.subscription.secret).toBeUndefined()

    const rotateRes = await request(app)
      .post(`/api/webhooks/${id}/rotate-secret?orgId=org-a`)
      .set('Authorization', `Bearer ${makeToken('user-1')}`)

    expect(rotateRes.status).toBe(200)
    expect(rotateRes.body.secret).toBeDefined()
    expect(rotateRes.body.subscription.id).toBe(id)

    const deleteRes = await request(app)
      .delete(`/api/webhooks/${id}?orgId=org-a`)
      .set('Authorization', `Bearer ${makeToken('user-1')}`)

    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.deleted).toBe(true)
  })

  it('rejects SSRF-style URLs and returns the validation envelope', async () => {
    const invalidRes = await request(app)
      .post('/api/webhooks?orgId=org-a')
      .set('Authorization', `Bearer ${makeToken('user-1')}`)
      .send({ url: 'http://127.0.0.1/hook', events: ['vault_created'], active: true })

    expect(invalidRes.status).toBe(400)
    expect(invalidRes.body.error.code).toBe('VALIDATION_ERROR')
    expect(invalidRes.body.error.message).toMatch(/not permitted/i)

    const validationRes = await request(app)
      .post('/api/webhooks?orgId=org-a')
      .set('Authorization', `Bearer ${makeToken('user-1')}`)
      .send({ url: 'not-a-url', events: 'vault_created', active: true })

    expect(validationRes.status).toBe(400)
    expect(validationRes.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('isolates subscriptions by organization and blocks cross-org access', async () => {
    const createRes = await request(app)
      .post('/api/webhooks?orgId=org-a')
      .set('Authorization', `Bearer ${makeToken('user-1')}`)
      .send({ url: 'https://example.com/webhook', events: ['vault_created'], active: true })

    expect(createRes.status).toBe(201)

    const listRes = await request(app)
      .get('/api/webhooks?orgId=org-b')
      .set('Authorization', `Bearer ${makeToken('user-2')}`)

    expect(listRes.status).toBe(200)
    expect(listRes.body.subscriptions).toEqual([])

    const getRes = await request(app)
      .get(`/api/webhooks/${createRes.body.subscription.id}?orgId=org-b`)
      .set('Authorization', `Bearer ${makeToken('user-2')}`)

    expect(getRes.status).toBe(404)
    expect(getRes.body.error.code).toBe('NOT_FOUND')
  })
})

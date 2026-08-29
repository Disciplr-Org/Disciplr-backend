/**
 * Route-level boundary tests for the webhook subscription management API
 * (`src/routes/webhooks.ts`).
 *
 * The auth + org-access middleware are mocked (the real `requireOrgAccess`
 * verifies DB membership server-side); the express router, zod schemas, and
 * error handler run for real. Focus points:
 *   - ownership of a subscriber is checked server-side (org-scoped delete),
 *     never inferred from client state
 *   - malformed `:id` route params are rejected at the boundary with 400
 *   - permission behavior (non-member → 403 via the authz boundary)
 */
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { jest } from '@jest/globals'

// A member of org A hitting an endpoint. `orgAllowed` lets tests simulate the
// org-access boundary denying a caller (a real non-member) with 403.
let orgAllowed = true

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

const { AppError } = await import('../middleware/errorHandler.js')

jest.unstable_mockModule('../middleware/orgAuth.js', () => ({
  requireOrgAccess: () => (_req: Request, _res: Response, next: NextFunction) => {
    if (!orgAllowed) {
      next(AppError.forbidden())
      return
    }
    next()
  },
}))

const mockAddSubscriber = jest.fn<any>()
const mockListSubscribers = jest.fn<any>()
const mockRemoveSubscriberForOrg = jest.fn<any>()
const mockRotateSubscriberSecret = jest.fn<any>()
const mockIsUrlAllowed = jest.fn<any>()

jest.unstable_mockModule('../services/webhooks.js', () => ({
  addSubscriber: mockAddSubscriber,
  listSubscribers: mockListSubscribers,
  removeSubscriberForOrg: mockRemoveSubscriberForOrg,
  rotateSubscriberSecret: mockRotateSubscriberSecret,
  isUrlAllowed: mockIsUrlAllowed,
  // Imported by the real types/webhook.ts schema for event-type validation.
  KNOWN_EVENT_TYPES: new Set([
    'vault_created',
    'vault_completed',
    'vault_failed',
    'vault_cancelled',
    'milestone_created',
    'milestone_validated',
    'settlement_summary',
  ]),
}))

const { webhookRouter } = await import('../routes/webhooks.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

const ORG = 'org-1'
const OTHER_ORG = 'org-2'

const makeSub = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  url: 'https://hooks.example.com/cb',
  secret: 'a-valid-secret-key',
  events: ['vault_created'],
  active: true,
  orgId: ORG,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const app = express()
app.use(express.json())
app.use('/api/webhooks', webhookRouter)
app.use(errorHandler)

beforeEach(() => {
  jest.clearAllMocks()
  orgAllowed = true
})

describe('ownership boundary — DELETE /:id', () => {
  it('deletes only a subscriber owned by the caller’s org (org-scoped)', async () => {
    const sub = makeSub()
    mockRemoveSubscriberForOrg.mockResolvedValue(true)

    const res = await request(app)
      .delete(`/api/webhooks/${sub.id}`)
      .query({ orgId: ORG })
      .send()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: true })
    // Ownership is enforced server-side: removal is scoped by the org id.
    expect(mockRemoveSubscriberForOrg).toHaveBeenCalledWith(sub.id, ORG)
  })

  it('returns 404 for a subscriber that belongs to a different org (no cross-org delete)', async () => {
    const attackerSub = makeSub({ id: randomUUID() })
    // Server-side lookup for { id, organization_id: ORG } finds nothing.
    mockRemoveSubscriberForOrg.mockResolvedValue(false)

    const res = await request(app)
      .delete(`/api/webhooks/${attackerSub.id}`)
      .query({ orgId: ORG })
      .send()

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(mockRemoveSubscriberForOrg).toHaveBeenCalledWith(attackerSub.id, ORG)
  })
})

describe('route-parameter boundary — malformed :id', () => {
  it('rejects a malformed id on DELETE /:id with 400 before any store call', async () => {
    const res = await request(app).delete('/api/webhooks/not-a-uuid').query({ orgId: ORG }).send()
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(mockRemoveSubscriberForOrg).not.toHaveBeenCalled()
  })

  it('rejects a malformed id on GET /:id with 400', async () => {
    const res = await request(app).get('/api/webhooks/not-a-uuid').query({ orgId: ORG })
    expect(res.status).toBe(400)
    expect(mockListSubscribers).not.toHaveBeenCalled()
  })

  it('rejects a malformed id on POST /:id/rotate-secret with 400', async () => {
    const res = await request(app).post('/api/webhooks/not-a-uuid/rotate-secret').query({ orgId: ORG }).send({})
    expect(res.status).toBe(400)
    expect(mockRotateSubscriberSecret).not.toHaveBeenCalled()
  })

  it('rejects when orgId is missing on DELETE /:id', async () => {
    const res = await request(app)
      .delete(`/api/webhooks/${randomUUID()}`)
      .query({})
      .send()
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })
})

describe('permission boundary', () => {
  it('denies a caller who is not authorized for the org (403 via authz boundary)', async () => {
    orgAllowed = false
    const res = await request(app).get(`/api/webhooks/${randomUUID()}`).query({ orgId: OTHER_ORG })
    expect(res.status).toBe(403)
  })
})

describe('happy path', () => {
  it('lists subscribers and rotates a secret for an owned subscriber', async () => {
    const sub = makeSub()
    mockListSubscribers.mockResolvedValue([sub])
    mockRotateSubscriberSecret.mockResolvedValue({ ...sub, secret: 'a-new-long-secret' })

    const listRes = await request(app).get('/api/webhooks').query({ orgId: ORG })
    expect(listRes.status).toBe(200)
    expect(listRes.body.subscriptions[0].id).toBe(sub.id)

    const rotateRes = await request(app)
      .post(`/api/webhooks/${sub.id}/rotate-secret`)
      .query({ orgId: ORG })
      .send({})
    expect(rotateRes.status).toBe(200)
    expect(mockRotateSubscriberSecret).toHaveBeenCalledWith(sub.id, expect.any(String), ORG)
  })

  it('creates a subscriber', async () => {
    mockIsUrlAllowed.mockReturnValue(true)
    mockAddSubscriber.mockResolvedValue(makeSub())

    const res = await request(app)
      .post('/api/webhooks')
      .query({ orgId: ORG })
      .send({ url: 'https://hooks.example.com/cb', events: ['vault_created'], active: true })

    expect(res.status).toBe(201)
    expect(mockAddSubscriber).toHaveBeenCalledWith(ORG, expect.any(String), expect.any(String), ['vault_created'])
  })
})
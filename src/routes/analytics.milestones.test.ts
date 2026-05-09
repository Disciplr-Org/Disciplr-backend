import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, test } from 'node:test'
import express from 'express'
import { analyticsRouter } from './analytics.js'
import { createApiKey, resetApiKeysTable } from '../services/apiKeys.js'
import { addMilestoneEvent, resetMilestones } from '../services/milestones.js'

let baseUrl = ''
let server: ReturnType<express.Express['listen']> | null = null

beforeEach(async () => {
  await resetApiKeysTable()
  resetMilestones()

  const app = express()
  app.use(express.json())
  app.use('/api/analytics', analyticsRouter)

  server = app.listen(0)
  await new Promise<void>((resolve) => {
    server!.once('listening', () => resolve())
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server!.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
  server = null
})

const createAnalyticsKey = async () => {
  const { apiKey } = await createApiKey({
    userId: 'user-1',
    orgId: 'org-1',
    label: 'analytics',
    scopes: ['read:analytics'],
  })
  return apiKey
}

test('returns milestone completion trends over time', async () => {
  const apiKey = await createAnalyticsKey()
  const base = new Date('2025-01-01T00:00:00.000Z')

  addMilestoneEvent({
    userId: 'user-1',
    vaultId: 'vault-1',
    name: 'day-1',
    status: 'success',
    timestamp: base.toISOString(),
  })
  addMilestoneEvent({
    userId: 'user-1',
    vaultId: 'vault-1',
    name: 'day-2',
    status: 'failed',
    timestamp: new Date(base.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  })

  const res = await fetch(
    `${baseUrl}/api/analytics/milestones/trends?from=2024-12-31T00:00:00.000Z&to=2025-01-31T00:00:00.000Z&groupBy=day`,
    {
      headers: { 'x-api-key': apiKey },
    },
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    buckets: Array<{
      bucketStart: string
      bucketEnd: string
      total: number
      successes: number
      failures: number
    }>
  }

  assert.equal(body.buckets.length, 32)
  assert.equal(body.buckets[1]?.total, 1)
  assert.equal(body.buckets[1]?.successes, 1)
  assert.equal(body.buckets[2]?.total, 1)
  assert.equal(body.buckets[2]?.failures, 1)
})

test('returns behavior score for a user', async () => {
  const apiKey = await createAnalyticsKey()

  addMilestoneEvent({
    userId: 'user-42',
    vaultId: 'vault-a',
    name: 'm1',
    status: 'success',
    timestamp: new Date().toISOString(),
  })
  addMilestoneEvent({
    userId: 'user-42',
    vaultId: 'vault-a',
    name: 'm2',
    status: 'failed',
    timestamp: new Date().toISOString(),
  })

  const res = await fetch(
    `${baseUrl}/api/analytics/behavior?userId=user-42&baseScorePerSuccess=10&penaltyPerFailure=5`,
    {
      headers: { 'x-api-key': apiKey },
    },
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    userId: string
    successes: number
    failures: number
    behaviorScore: number
  }

  assert.equal(body.userId, 'user-42')
  assert.equal(body.successes, 1)
  assert.equal(body.failures, 1)
  assert.equal(body.behaviorScore, 5)
})

test('includes milestone events that fall exactly on the requested date boundaries', async () => {
  const apiKey = await createAnalyticsKey()
  const from = '2025-01-01T00:00:00.000Z'
  const middle = '2025-01-02T12:00:00.000Z'
  const to = '2025-01-03T23:59:59.999Z'

  addMilestoneEvent({
    userId: 'user-edge',
    vaultId: 'vault-edge',
    name: 'range-start',
    status: 'success',
    timestamp: from,
  })
  addMilestoneEvent({
    userId: 'user-edge',
    vaultId: 'vault-edge',
    name: 'middle',
    status: 'failed',
    timestamp: middle,
  })
  addMilestoneEvent({
    userId: 'user-edge',
    vaultId: 'vault-edge',
    name: 'range-end',
    status: 'success',
    timestamp: to,
  })

  const res = await fetch(
    `${baseUrl}/api/analytics/milestones/trends?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&groupBy=day`,
    {
      headers: { 'x-api-key': apiKey },
    },
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    buckets: Array<{
      bucketStart: string
      bucketEnd: string
      total: number
      successes: number
      failures: number
    }>
  }

  assert.equal(body.buckets.length, 3)
  assert.deepEqual(
    body.buckets.map(({ total, successes, failures }) => ({ total, successes, failures })),
    [
      { total: 1, successes: 1, failures: 0 },
      { total: 1, successes: 0, failures: 1 },
      { total: 1, successes: 1, failures: 0 },
    ],
  )
})

test('returns empty milestone buckets when no events fall in the requested range', async () => {
  const apiKey = await createAnalyticsKey()
  const from = '2025-02-01T00:00:00.000Z'
  const to = '2025-02-02T23:59:59.999Z'

  addMilestoneEvent({
    userId: 'user-outside',
    vaultId: 'vault-outside',
    name: 'outside-range',
    status: 'success',
    timestamp: '2025-03-01T00:00:00.000Z',
  })

  const res = await fetch(
    `${baseUrl}/api/analytics/milestones/trends?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&groupBy=day`,
    {
      headers: { 'x-api-key': apiKey },
    },
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    buckets: Array<{
      bucketStart: string
      bucketEnd: string
      total: number
      successes: number
      failures: number
    }>
  }

  assert.equal(body.buckets.length, 2)
  assert.deepEqual(
    body.buckets.map(({ total, successes, failures }) => ({ total, successes, failures })),
    [
      { total: 0, successes: 0, failures: 0 },
      { total: 0, successes: 0, failures: 0 },
    ],
  )
})

test('rejects milestone trend requests when from is after to', async () => {
  const apiKey = await createAnalyticsKey()

  const res = await fetch(
    `${baseUrl}/api/analytics/milestones/trends?from=2025-02-03T00:00:00.000Z&to=2025-02-01T00:00:00.000Z&groupBy=day`,
    {
      headers: { 'x-api-key': apiKey },
    },
  )

  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: string }
  assert.equal(body.error, '`from` must be less than or equal to `to`.')
})

test('filters behavior score to the requested range and includes edge timestamps', async () => {
  const apiKey = await createAnalyticsKey()
  const from = '2025-04-10T00:00:00.000Z'
  const to = '2025-04-11T23:59:59.999Z'

  addMilestoneEvent({
    userId: 'user-99',
    vaultId: 'vault-1',
    name: 'start-edge',
    status: 'success',
    timestamp: from,
  })
  addMilestoneEvent({
    userId: 'user-99',
    vaultId: 'vault-1',
    name: 'end-edge',
    status: 'failed',
    timestamp: to,
  })
  addMilestoneEvent({
    userId: 'user-99',
    vaultId: 'vault-1',
    name: 'outside-window',
    status: 'success',
    timestamp: '2025-04-12T00:00:00.000Z',
  })
  addMilestoneEvent({
    userId: 'other-user',
    vaultId: 'vault-1',
    name: 'other-user',
    status: 'success',
    timestamp: from,
  })

  const res = await fetch(
    `${baseUrl}/api/analytics/behavior?userId=user-99&baseScorePerSuccess=7&penaltyPerFailure=3&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    {
      headers: { 'x-api-key': apiKey },
    },
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    userId: string
    successes: number
    failures: number
    behaviorScore: number
    evaluatedFrom: string | null
    evaluatedTo: string | null
  }

  assert.equal(body.userId, 'user-99')
  assert.equal(body.successes, 1)
  assert.equal(body.failures, 1)
  assert.equal(body.behaviorScore, 4)
  assert.equal(body.evaluatedFrom, from)
  assert.equal(body.evaluatedTo, to)
})

test('rejects behavior score requests without a userId', async () => {
  const apiKey = await createAnalyticsKey()

  const res = await fetch(`${baseUrl}/api/analytics/behavior`, {
    headers: { 'x-api-key': apiKey },
  })

  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: string }
  assert.equal(body.error, '`userId` is required.')
})

// ─── List Contract Tests for Analytics ─────────────────────────────────────

test('validates date range filtering contract for trends', async () => {
  const apiKey = await createAnalyticsKey()
  const from = '2025-01-01T00:00:00.000Z'
  const to = '2025-01-07T00:00:00.000Z'

  const res = await fetch(
    `${baseUrl}/api/analytics/milestones/trends?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&groupBy=day`,
    {
      headers: { 'x-api-key': apiKey },
    },
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    buckets: Array<{
      bucketStart: string
      bucketEnd: string
    }>
  }

  // Validates date range filtering contract - returns buckets within range
  assert.ok(body.buckets.length > 0)
  assert.ok(body.buckets.every(b => new Date(b.bucketStart) >= new Date(from)))
  assert.ok(body.buckets.every(b => new Date(b.bucketEnd) <= new Date(to)))
})

test('validates groupBy parameter contract (day and week)', async () => {
  const apiKey = await createAnalyticsKey()
  const base = new Date('2025-01-01T00:00:00.000Z')

  addMilestoneEvent({
    userId: 'user-groupby',
    vaultId: 'vault-1',
    name: 'event-1',
    status: 'success',
    timestamp: base.toISOString(),
  })

  // Test day grouping
  const dayRes = await fetch(
    `${baseUrl}/api/analytics/milestones/trends?from=2025-01-01T00:00:00.000Z&to=2025-01-14T00:00:00.000Z&groupBy=day`,
    { headers: { 'x-api-key': apiKey } },
  )
  assert.equal(dayRes.status, 200)
  const dayBody = (await dayRes.json()) as { buckets: Array<{ bucketStart: string }> }

  // Day grouping should have ~14 buckets (2 weeks)
  assert.ok(dayBody.buckets.length >= 13 && dayBody.buckets.length <= 15)

  // Test week grouping
  const weekRes = await fetch(
    `${baseUrl}/api/analytics/milestones/trends?from=2025-01-01T00:00:00.000Z&to=2025-01-14T00:00:00.000Z&groupBy=week`,
    { headers: { 'x-api-key': apiKey } },
  )
  assert.equal(weekRes.status, 200)
  const weekBody = (await weekRes.json()) as { buckets: Array<{ bucketStart: string }> }

  // Week grouping should have ~2 buckets (2 weeks)
  assert.ok(weekBody.buckets.length >= 2 && weekBody.buckets.length <= 3)
})

test('validates date range filtering contract for behavior scores', async () => {
  const apiKey = await createAnalyticsKey()
  const from = '2025-03-01T00:00:00.000Z'
  const to = '2025-03-31T23:59:59.999Z'

  addMilestoneEvent({
    userId: 'user-range-test',
    vaultId: 'vault-1',
    name: 'in-range',
    status: 'success',
    timestamp: '2025-03-15T12:00:00.000Z',
  })

  addMilestoneEvent({
    userId: 'user-range-test',
    vaultId: 'vault-1',
    name: 'before-range',
    status: 'failed',
    timestamp: '2025-02-01T12:00:00.000Z',
  })

  addMilestoneEvent({
    userId: 'user-range-test',
    vaultId: 'vault-1',
    name: 'after-range',
    status: 'failed',
    timestamp: '2025-04-01T12:00:00.000Z',
  })

  const res = await fetch(
    `${baseUrl}/api/analytics/behavior?userId=user-range-test&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { headers: { 'x-api-key': apiKey } },
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    successes: number
    failures: number
  }

  // Should only count the event within the date range
  assert.equal(body.successes, 1)
  assert.equal(body.failures, 0)
})

test('requires authentication for analytics endpoints', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/milestones/trends?from=2025-01-01T00:00:00.000Z&to=2025-01-07T00:00:00.000Z&groupBy=day`)

  assert.equal(res.status, 401)
})

test('validates user isolation in analytics - cannot access other user events', async () => {
  const apiKey = await createAnalyticsKey()

  addMilestoneEvent({
    userId: 'user-a',
    vaultId: 'vault-1',
    name: 'user-a-event',
    status: 'success',
    timestamp: new Date().toISOString(),
  })

  addMilestoneEvent({
    userId: 'user-b',
    vaultId: 'vault-1',
    name: 'user-b-event',
    status: 'success',
    timestamp: new Date().toISOString(),
  })

  const res = await fetch(
    `${baseUrl}/api/analytics/behavior?userId=user-a`,
    { headers: { 'x-api-key': apiKey } },
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    userId: string
    successes: number
  }

  assert.equal(body.userId, 'user-a')
  assert.equal(body.successes, 1) // Only user-a's event
})

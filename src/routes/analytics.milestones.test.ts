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
  resetApiKeysTable()
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

const createAnalyticsKey = () => {
  const { apiKey } = createApiKey({
    userId: 'user-1',
    orgId: 'org-1',
    label: 'analytics',
    scopes: ['read:analytics'],
  })
  return apiKey
}

test('returns milestone completion trends over time', async () => {
  const apiKey = createAnalyticsKey()
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
  const apiKey = createAnalyticsKey()

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
  const apiKey = createAnalyticsKey()
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
  const apiKey = createAnalyticsKey()
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
  const apiKey = createAnalyticsKey()

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
  const apiKey = createAnalyticsKey()
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
  const apiKey = createAnalyticsKey()

  const res = await fetch(`${baseUrl}/api/analytics/behavior`, {
    headers: { 'x-api-key': apiKey },
  })

  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: string }
  assert.equal(body.error, '`userId` is required.')
})

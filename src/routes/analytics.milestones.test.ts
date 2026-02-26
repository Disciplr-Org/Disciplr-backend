import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, test } from 'node:test'
import { app } from '../app.js'
import { resetApiKeysTable, createApiKey } from '../services/apiKeys.js'
import { resetMilestones, addMilestoneEvent } from '../services/milestones.js'

let baseUrl = ''
let server: ReturnType<typeof app.listen> | null = null

beforeEach(async () => {
  resetApiKeysTable()
  resetMilestones()
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
    }
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.ok(Array.isArray(body.buckets))
  assert.equal(body.buckets.length > 0, true)
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
    }
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.equal(body.userId, 'user-42')
  assert.equal(typeof body.behaviorScore, 'number')
})


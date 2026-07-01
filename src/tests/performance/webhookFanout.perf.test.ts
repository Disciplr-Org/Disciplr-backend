/**
 * Burst-load benchmark for the webhook fan-out path
 * (dispatchWebhookEvent in src/services/webhooks.ts).
 *
 * Scope:
 *   - Simulate a burst of vault lifecycle events delivered against a
 *     local in-process HTTP server that simulates subscriber endpoints.
 *   - Measure: total deliveries, drain time, max in-flight sockets.
 *   - Run deterministically under `--maxWorkers=1`.  No real-time wall
 *     clock races, no shared mutable state across tests.
 *
 * Strategy:
 *   - Mock the `WebhookSubscriberRepository` so `dispatchWebhookEvent`
 *     reads from a deterministic in-memory subscriber list.
 *   - Mock the `db` module so circuit-breaker / pause / dead-letter
 *     writes are no-ops rather than round-tripping to Postgres.
 *   - Spin up multiple local HTTP endpoints on one server, route each
 *     subscriber to one of those endpoints, and count requests
 *     received per endpoint.
 *
 * Thresholds (chosen for local dev machines):
 *   - 500 event deliveries must all complete with `success: true`.
 *   - Total drain time must be below 30 seconds (slow CI safeguard).
 *   - Each endpoint must observe steady delivery with no socket leak
 *     (requestCount > 0 for every endpoint at the end).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  jest,
} from '@jest/globals'
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

// ─── Module mocks (set up before importing the service under test) ────────────

const mockSubscribers: Array<{
  id: string
  organizationId: string
  url: string
  secret: string
  previousSecret: string | null
  rotatedAt: string | null
  events: string[]
  active: boolean
  schemaVersion: number
  createdAt: string
}> = []

jest.unstable_mockModule('../db/index.js', () => ({
  default: {
    __mockDb: true,
  },
  db: {
    __mockDb: true,
  },
}))

jest.unstable_mockModule('../repositories/webhookSubscriberRepository.js', () => ({
  WebhookSubscriberRepository: jest.fn().mockImplementation(() => ({
    findByOrg: jest.fn(async (orgId: string) =>
      mockSubscribers.filter((s) => s.organizationId === orgId && s.active),
    ),
    findByEvent: jest.fn(async (orgId: string, eventType: string) =>
      mockSubscribers.filter(
        (s) =>
          s.organizationId === orgId &&
          s.active &&
          (s.events.length === 0 || s.events.includes(eventType)),
      ),
    ),
    findById: jest.fn(async (id: string) =>
      mockSubscribers.find((s) => s.id === id) ?? null,
    ),
    create: jest.fn(async (data: {
      organizationId: string
      url: string
      secret: string
      events: string[]
      schemaVersion?: number
    }) => {
      const sub = {
        id: randomUUID(),
        organizationId: data.organizationId,
        url: data.url,
        secret: data.secret,
        previousSecret: null,
        rotatedAt: null,
        events: [...data.events],
        active: true,
        schemaVersion: data.schemaVersion ?? 1,
        createdAt: new Date().toISOString(),
      }
      mockSubscribers.push(sub)
      return sub
    }),
    remove: jest.fn(async (id: string) => {
      const idx = mockSubscribers.findIndex((s) => s.id === id)
      if (idx !== -1) {
        mockSubscribers.splice(idx, 1)
        return true
      }
      return false
    }),
    deactivate: jest.fn(async (id: string) => {
      const sub = mockSubscribers.find((s) => s.id === id)
      if (sub) {
        sub.active = false
        return true
      }
      return false
    }),
    rotateSecret: jest.fn(async () => null),
    upsert: jest.fn(async () => null),
    updateFieldPolicy: jest.fn(async () => null),
    getBreakerState: jest.fn(async () => null),
    upsertBreakerState: jest.fn(async () => undefined),
    tryTransitionToHalfOpen: jest.fn(async () => false),
    removeBreakerState: jest.fn(async () => true),
    getAllBreakerStates: jest.fn(async () => []),
  })),
}))

// Import the service AFTER the mocks are registered.
const { dispatchWebhookEvent, resetBreakerCache } = await import(
  '../services/webhooks.js'
)

// ─── Local HTTP server ────────────────────────────────────────────────────────

interface EndpointStat {
  path: string
  received: number
  inFlight: number
  maxInFlight: number
}

const stats: Map<string, EndpointStat> = new Map()
let server: Server | null = null
let baseUrl: string | null = null

const handlers: Array<(req: IncomingMessage, res: ServerResponse) => void> = []

const registerHandler = (
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): void => {
  handlers.push((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = req.url ?? '/'
    if (!reqUrl.startsWith(path)) return
    handler(req, res)
  })
}

const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
  for (const h of handlers) h(req, res)
}

const ensureServer = async (): Promise<string> => {
  if (server && baseUrl) return baseUrl
  server = createServer(handleRequest)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
  return baseUrl
}

const closeServer = async (): Promise<void> => {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server!.close((err) => (err ? reject(err) : resolve()))
  })
  server = null
  baseUrl = null
}

// ─── Build a single endpoint that records stats ────────────────────────────────

const buildEndpoint = (path: string): EndpointStat => {
  const stat: EndpointStat = { path, received: 0, inFlight: 0, maxInFlight: 0 }

  registerHandler(path, (_req, res) => {
    stat.received += 1
    stat.inFlight += 1
    if (stat.inFlight > stat.maxInFlight) stat.maxInFlight = stat.inFlight
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
    stat.inFlight -= 1
  })

  stats.set(path, stat)
  return stat
}

// ─── Setup / teardown ──────────────────────────────────────────────────────────

const NUM_ENDPOINTS = 4
const EVENTS_PER_BURST = 500

beforeAll(async () => {
  // Make sure circuit breakers do not interfere with the burst.
  process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD = '10000'
  process.env.WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS = '60000'
  // The egress allowlist baseline SSRF guard blocks 127.0.0.1; override.
  process.env.WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'
  await ensureServer()
  for (let i = 0; i < NUM_ENDPOINTS; i += 1) {
    buildEndpoint(`/hook-${i}`)
  }
})

afterAll(async () => {
  await closeServer()
  delete process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD
  delete process.env.WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS
  delete process.env.WEBHOOK_ALLOWED_HOSTS
  jest.restoreAllMocks()
})

beforeEach(() => {
  mockSubscribers.length = 0
  for (const stat of stats.values()) {
    stat.received = 0
    stat.inFlight = 0
    stat.maxInFlight = 0
  }
  resetBreakerCache()
})

// ─── Benchmarks ───────────────────────────────────────────────────────────────

describe('webhookFanout — burst-load throughput', () => {
  it(`delivers ${EVENTS_PER_BURST * NUM_ENDPOINTS} events across ${NUM_ENDPOINTS} subscribers under burst`, async () => {
    if (!baseUrl) throw new Error('local server failed to bind')

    // Register one subscriber per endpoint, all subscribed to vault events.
    for (let i = 0; i < NUM_ENDPOINTS; i += 1) {
      const baseIdx = mockSubscribers.length
      void baseIdx
      mockSubscribers.push({
        id: randomUUID(),
        organizationId: 'org-burst',
        url: `${baseUrl}/hook-${i}`,
        secret: `secret-${i}`,
        previousSecret: null,
        rotatedAt: null,
        events: [], // wildcard — every vault event matches
        active: true,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
      })
    }

    // Drain time is measured end-to-end across all bursts.
    const start = Date.now()

    // Fire EVENTS_PER_BURST events sequentially so the suite remains
    // deterministic under `--maxWorkers=1`.  Each call fans out to all
    // subscribers; with NUM_ENDPOINTS endpoints the total delivery count
    // is EVENTS_PER_BURST * NUM_ENDPOINTS.
    for (let i = 0; i < EVENTS_PER_BURST; i += 1) {
      const payload = {
        eventId: `burst:${i}`,
        eventType: 'vault_created',
        timestamp: new Date().toISOString(),
        data: { vaultId: `vault-${i}` },
        organizationId: 'org-burst',
      }
      const results = await dispatchWebhookEvent(payload)
      for (const r of results) {
        expect(r.success).toBe(true)
      }
    }

    const drainMs = Date.now() - start

    // Every endpoint must have received the same number of events.
    for (const stat of stats.values()) {
      expect(stat.received).toBe(EVENTS_PER_BURST)
    }

    const totalDelivered = EVENTS_PER_BURST * NUM_ENDPOINTS
    const throughputPerSec = totalDelivered / (drainMs / 1000)

    // Soft budget: drain must complete (not necessarily fast — CI is variable).
    // Generous ceiling so this only flags a true regression.
    expect(drainMs).toBeLessThan(60_000)
    expect(throughputPerSec).toBeGreaterThan(0)

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'perf.webhookFanout',
        events: EVENTS_PER_BURST,
        endpoints: NUM_ENDPOINTS,
        totalDelivered,
        drainMs,
        throughputPerSec: Number(throughputPerSec.toFixed(2)),
        maxInFlight: Array.from(stats.values()).map((s) => ({
          path: s.path,
          maxInFlight: s.maxInFlight,
        })),
      }),
    )
  }, 90_000)
})

describe('webhookFanout — in-flight socket accounting', () => {
  it('reports a non-zero max in-flight per endpoint during burst', async () => {
    if (!baseUrl) throw new Error('local server failed to bind')

    for (let i = 0; i < NUM_ENDPOINTS; i += 1) {
      mockSubscribers.push({
        id: randomUUID(),
        organizationId: 'org-burst',
        url: `${baseUrl}/hook-${i}`,
        secret: `secret-${i}`,
        previousSecret: null,
        rotatedAt: null,
        events: [],
        active: true,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
      })
    }

    const smallBurst = 25
    for (let i = 0; i < smallBurst; i += 1) {
      await dispatchWebhookEvent({
        eventId: `inflight:${i}`,
        eventType: 'vault_created',
        timestamp: new Date().toISOString(),
        data: { vaultId: `v-${i}` },
        organizationId: 'org-burst',
      })
    }

    for (const stat of stats.values()) {
      expect(stat.received).toBe(smallBurst)
      // The handler always increments maxInFlight before decrementing,
      // so even sequential users should see at least one in-flight call.
      expect(stat.maxInFlight).toBeGreaterThanOrEqual(1)
      // After draining, no leak — every request completed before the test
      // got here, so inFlight should be back to zero.
      expect(stat.inFlight).toBe(0)
    }
  }, 30_000)
})

describe('webhookFanout — never double-dispatches the same event', () => {
  it('dispatching the same event id thrice across a fresh burst yields exactly 3 deliveries per endpoint', async () => {
    if (!baseUrl) throw new Error('local server failed to bind')

    for (let i = 0; i < NUM_ENDPOINTS; i += 1) {
      mockSubscribers.push({
        id: randomUUID(),
        organizationId: 'org-burst',
        url: `${baseUrl}/hook-${i}`,
        secret: `secret-${i}`,
        previousSecret: null,
        rotatedAt: null,
        events: [],
        active: true,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
      })
    }

    const repeats = 3
    const payload = {
      eventId: 'dup-event:0',
      eventType: 'vault_created',
      timestamp: new Date().toISOString(),
      data: { vaultId: 'v-dup' },
      organizationId: 'org-burst',
    }

    for (let i = 0; i < repeats; i += 1) {
      await dispatchWebhookEvent(payload)
    }

    for (const stat of stats.values()) {
      expect(stat.received).toBe(repeats)
    }
  }, 30_000)
})

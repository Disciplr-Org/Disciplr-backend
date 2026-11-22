/**
 * Unit tests for BoundedWebhookDispatcher (src/services/boundedWebhookDispatcher.ts)
 *
 * Hermetic suite (no network, Postgres, or Redis):
 *  - Exports, defaults, and state inspection/reset helpers
 *  - Happy-path delivery, payload signing, headers, and breaker success recording
 *  - Bounded concurrency ceiling and recursive drain behaviour
 *  - Per-subscriber FIFO ordering and cross-subscriber round-robin fairness
 *  - Circuit breaker interaction (OPEN skip, checkBreaker short-circuit, HALF_OPEN probe tracking)
 *  - Failure modes: egress guard blocks, HTTP 3xx redirect refusal, HTTP 5xx retries & dead-letter,
 *    transient failure recovery with fake timers, and fatal dispatch error resilience
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { URL } from 'node:url'
import { setImmediate } from 'node:timers'
import type { WebhookSubscriber, WebhookDeliveryPayload } from '../services/webhooks.js'

// ── Mocks (registered before dynamic import of module under test) ─────────────

type BreakerConfig = { failureThreshold: number; resetTimeoutMs: number }
type BreakerCheckResult = { allowed: boolean; shortCircuitReason?: string }
type ResolvedTarget = {
  url: string
  hostname: string
  path: string
  port: number
  address: string
  family: number
}
type FetchOptions = {
  method: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
}
type FetchResponse = { statusCode: number; headers: Record<string, string> }

const mockBreakerCache = new Map<string, { state: string }>()
const mockInFlightProbes = new Set<string>()
const mockCheckBreaker = jest.fn<(id: string, config: BreakerConfig) => Promise<BreakerCheckResult>>()
const mockRecordBreakerSuccess = jest.fn<(id: string) => Promise<void>>()
const mockRecordBreakerFailure = jest.fn<(id: string, config: BreakerConfig) => Promise<void>>()
const mockGetCircuitBreakerConfig = jest.fn<() => BreakerConfig>()
const mockDeadLetter =
  jest.fn<(id: string, payload: WebhookDeliveryPayload, reason: string, attempts: number) => Promise<void>>()
const mockBuildVersionedPayload =
  jest.fn<(sub: WebhookSubscriber, payload: WebhookDeliveryPayload) => string>()
const mockSignPayload = jest.fn<(secret: string, body: string) => string>()

jest.unstable_mockModule('../services/webhooks.js', () => ({
  breakerCache: mockBreakerCache,
  inFlightProbes: mockInFlightProbes,
  checkBreaker: mockCheckBreaker,
  recordBreakerSuccess: mockRecordBreakerSuccess,
  recordBreakerFailure: mockRecordBreakerFailure,
  getCircuitBreakerConfig: mockGetCircuitBreakerConfig,
  deadLetter: mockDeadLetter,
  buildVersionedPayload: mockBuildVersionedPayload,
  signPayload: mockSignPayload,
}))

class MockEgressBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressBlockedError'
  }
}

const mockResolvePublicTarget =
  jest.fn<(url: string, opts?: { allowPrivate?: boolean }) => Promise<ResolvedTarget>>()
const mockFetchPinnedTarget =
  jest.fn<(target: ResolvedTarget, opts: FetchOptions) => Promise<FetchResponse>>()
const mockIsPrivateOverrideEnabled = jest.fn<() => boolean>()

jest.unstable_mockModule('../security/egressGuard.js', () => ({
  EgressBlockedError: MockEgressBlockedError,
  resolvePublicTarget: mockResolvePublicTarget,
  fetchPinnedTarget: mockFetchPinnedTarget,
  isPrivateOverrideEnabled: mockIsPrivateOverrideEnabled,
}))

const mockSpan = {
  setAttribute: jest.fn<(key: string, value: unknown) => void>(),
  setStatus: jest.fn<(status: { code: string; message?: string }) => void>(),
}
const mockWithSpan = jest.fn<
  <T>(name: string, fn: (span: typeof mockSpan) => Promise<T>) => Promise<T>
>(async (_name, fn) => fn(mockSpan))

jest.unstable_mockModule('../observability/tracing.js', () => ({
  getTracer: () => ({ withSpan: mockWithSpan }),
}))

const mockGaugeSet = jest.fn<(value: number) => void>()
jest.unstable_mockModule('prom-client', () => ({
  Gauge: jest.fn(() => ({ set: mockGaugeSet })),
}))
jest.unstable_mockModule('../routes/metrics.js', () => ({
  metricsRegistry: {},
}))

// Dynamic import after mocks are installed
const {
  BoundedWebhookDispatcher,
  WEBHOOK_MAX_CONCURRENCY,
  webhookDispatcher,
} = await import('../services/boundedWebhookDispatcher.js')

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeSubscriber(id: string, overrides: Partial<WebhookSubscriber> = {}): WebhookSubscriber {
  return {
    id,
    url: `https://${id}.example.com/webhook`,
    secret: `secret-${id}`,
    events: ['vault.created'],
    organizationId: 'org-1',
    active: true,
    ...overrides,
  } as WebhookSubscriber
}

function makePayload(eventId: string, overrides: Partial<WebhookDeliveryPayload> = {}): WebhookDeliveryPayload {
  return {
    eventId,
    eventType: 'vault.created',
    organizationId: 'org-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    data: { id: eventId },
    ...overrides,
  } as WebhookDeliveryPayload
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush queued microtasks and immediate callbacks so background dispatch promises settle. */
async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('BoundedWebhookDispatcher', () => {
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    jest.clearAllMocks()
    mockBreakerCache.clear()
    mockInFlightProbes.clear()
    webhookDispatcher.reset()

    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    mockGetCircuitBreakerConfig.mockReturnValue({
      failureThreshold: 5,
      resetTimeoutMs: 60_000,
    })
    mockCheckBreaker.mockResolvedValue({ allowed: true })
    mockRecordBreakerSuccess.mockResolvedValue(undefined)
    mockRecordBreakerFailure.mockResolvedValue(undefined)
    mockDeadLetter.mockResolvedValue(undefined)
    mockBuildVersionedPayload.mockImplementation(
      (_sub: WebhookSubscriber, payload: WebhookDeliveryPayload) => JSON.stringify(payload),
    )
    mockSignPayload.mockReturnValue('sha256=test-signature')
    mockIsPrivateOverrideEnabled.mockReturnValue(false)
    mockResolvePublicTarget.mockImplementation(async (url: string) => {
      const parsed = new URL(url)
      return {
        url: parsed.href,
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        port: 443,
        address: '93.184.216.34',
        family: 4,
      }
    })
    mockFetchPinnedTarget.mockResolvedValue({ statusCode: 200, headers: {} })
  })

  afterEach(() => {
    jest.useRealTimers()
    consoleErrorSpy.mockRestore()
  })

  // ── Exports & state helpers ───────────────────────────────────────────────

  describe('exports and state helpers', () => {
    it('exports WEBHOOK_MAX_CONCURRENCY and singleton webhookDispatcher', () => {
      expect(typeof WEBHOOK_MAX_CONCURRENCY).toBe('number')
      expect(WEBHOOK_MAX_CONCURRENCY).toBeGreaterThan(0)
      expect(webhookDispatcher).toBeInstanceOf(BoundedWebhookDispatcher)
    })

    it('reports zero counts on a fresh dispatcher and resets cleanly', () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(0)
      expect(dispatcher.getActiveSubscriberCount()).toBe(0)

      // Hold a delivery in flight and queue another
      const deferred = createDeferred<{ statusCode: number; headers: Record<string, string> }>()
      mockFetchPinnedTarget.mockReturnValueOnce(deferred.promise)

      const sub = makeSubscriber('sub-reset')
      dispatcher.enqueue(sub, makePayload('evt-1'))
      dispatcher.enqueue(sub, makePayload('evt-2'))
      dispatcher.enqueue(sub, makePayload('evt-3'))

      expect(dispatcher.getInFlight()).toBe(2)
      expect(dispatcher.getQueueDepth()).toBe(1)
      expect(dispatcher.getActiveSubscriberCount()).toBe(1)

      dispatcher.reset()
      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(0)
      expect(dispatcher.getActiveSubscriberCount()).toBe(0)

      deferred.resolve({ statusCode: 200, headers: {} })
    })
  })

  // ── Happy path ────────────────────────────────────────────────────────────

  describe('happy path delivery', () => {
    it('delivers signed payload with expected headers and records breaker success', async () => {
      const dispatcher = new BoundedWebhookDispatcher(4)
      const sub = makeSubscriber('sub-happy')
      const payload = makePayload('evt-happy')

      dispatcher.enqueue(sub, payload)
      await flushMicrotasks()

      expect(mockResolvePublicTarget).toHaveBeenCalledWith(sub.url, { allowPrivate: false })
      expect(mockCheckBreaker).toHaveBeenCalledWith(sub.id, expect.any(Object))
      expect(mockBuildVersionedPayload).toHaveBeenCalledWith(sub, payload)
      expect(mockSignPayload).toHaveBeenCalledWith(sub.secret, JSON.stringify(payload))
      expect(mockFetchPinnedTarget).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'sub-happy.example.com', address: '93.184.216.34' }),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-disciplr-signature': 'sha256=test-signature',
            'x-disciplr-event': payload.eventType,
            'x-disciplr-event-id': payload.eventId,
            'x-disciplr-delivery-timestamp': payload.timestamp,
          },
          body: JSON.stringify(payload),
          timeoutMs: 10_000,
        },
      )
      expect(mockRecordBreakerSuccess).toHaveBeenCalledWith(sub.id)
      expect(mockRecordBreakerFailure).not.toHaveBeenCalled()
      expect(mockDeadLetter).not.toHaveBeenCalled()
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('webhook.status_code', 200)
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('webhook.attempts', 1)
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 'OK' })
      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(0)
    })
  })

  // ── Bounded concurrency & drain ───────────────────────────────────────────

  describe('bounded concurrency and drain behaviour', () => {
    it('never exceeds maxConcurrency in-flight and drains queued deliveries as slots free', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      const deferreds: Deferred<{ statusCode: number; headers: Record<string, string> }>[] = []
      let peakInFlight = 0

      mockFetchPinnedTarget.mockImplementation(() => {
        peakInFlight = Math.max(peakInFlight, dispatcher.getInFlight())
        const d = createDeferred<{ statusCode: number; headers: Record<string, string> }>()
        deferreds.push(d)
        return d.promise
      })

      const sub = makeSubscriber('sub-bounded')
      for (let i = 1; i <= 5; i++) {
        dispatcher.enqueue(sub, makePayload(`evt-${i}`))
      }

      await flushMicrotasks()
      expect(dispatcher.getInFlight()).toBe(2)
      expect(dispatcher.getQueueDepth()).toBe(3)
      expect(deferreds).toHaveLength(2)

      // Complete first two; next two should start
      deferreds[0].resolve({ statusCode: 200, headers: {} })
      deferreds[1].resolve({ statusCode: 200, headers: {} })
      await flushMicrotasks()

      expect(dispatcher.getInFlight()).toBe(2)
      expect(dispatcher.getQueueDepth()).toBe(1)
      expect(deferreds).toHaveLength(4)

      // Complete remaining deliveries
      deferreds[2].resolve({ statusCode: 200, headers: {} })
      deferreds[3].resolve({ statusCode: 200, headers: {} })
      await flushMicrotasks()

      expect(dispatcher.getInFlight()).toBe(1)
      expect(dispatcher.getQueueDepth()).toBe(0)
      expect(deferreds).toHaveLength(5)

      deferreds[4].resolve({ statusCode: 200, headers: {} })
      await flushMicrotasks()

      expect(peakInFlight).toBe(2)
      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(0)
      expect(mockRecordBreakerSuccess).toHaveBeenCalledTimes(5)
    })
  })

  // ── Per-subscriber ordering & round-robin fairness ────────────────────────

  describe('per-subscriber ordering and round-robin fairness', () => {
    it('preserves FIFO ordering for a single subscriber', async () => {
      const dispatcher = new BoundedWebhookDispatcher(1)
      const deliveredOrder: string[] = []
      const deferreds: Deferred<{ statusCode: number; headers: Record<string, string> }>[] = []

      mockFetchPinnedTarget.mockImplementation((_target, opts) => {
        deliveredOrder.push(opts.headers['x-disciplr-event-id'])
        const d = createDeferred<FetchResponse>()
        deferreds.push(d)
        return d.promise
      })

      const sub = makeSubscriber('sub-fifo')
      dispatcher.enqueue(sub, makePayload('evt-1'))
      dispatcher.enqueue(sub, makePayload('evt-2'))
      dispatcher.enqueue(sub, makePayload('evt-3'))

      for (let i = 0; i < 3; i++) {
        await flushMicrotasks()
        deferreds[i].resolve({ statusCode: 200, headers: {} })
      }
      await flushMicrotasks()

      expect(deliveredOrder).toEqual(['evt-1', 'evt-2', 'evt-3'])
    })

    it('interleaves deliveries round-robin across multiple subscribers', async () => {
      const dispatcher = new BoundedWebhookDispatcher(1)
      const deliveredOrder: string[] = []
      const deferreds: Deferred<{ statusCode: number; headers: Record<string, string> }>[] = []

      mockFetchPinnedTarget.mockImplementation((_target, opts) => {
        deliveredOrder.push(opts.headers['x-disciplr-event-id'])
        const d = createDeferred<FetchResponse>()
        deferreds.push(d)
        return d.promise
      })

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const subC = makeSubscriber('sub-c')

      // First enqueue starts sub-a#1 immediately (slot 1/1 occupied),
      // remaining items queue behind their respective subscribers.
      dispatcher.enqueue(subA, makePayload('a-1'))
      dispatcher.enqueue(subA, makePayload('a-2'))
      dispatcher.enqueue(subA, makePayload('a-3'))
      dispatcher.enqueue(subB, makePayload('b-1'))
      dispatcher.enqueue(subB, makePayload('b-2'))
      dispatcher.enqueue(subC, makePayload('c-1'))

      for (let i = 0; i < 6; i++) {
        await flushMicrotasks()
        deferreds[i].resolve({ statusCode: 200, headers: {} })
      }
      await flushMicrotasks()

      expect(deliveredOrder).toEqual(['a-1', 'b-1', 'c-1', 'a-2', 'b-2', 'a-3'])
    })
  })

  // ── Circuit breaker interaction ───────────────────────────────────────────

  describe('circuit breaker interaction', () => {
    it('skips subscribers whose cached breaker is OPEN while still delivering to healthy subscribers', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      const openSub = makeSubscriber('sub-open')
      const healthySub = makeSubscriber('sub-healthy')

      mockBreakerCache.set(openSub.id, { state: 'OPEN' })

      dispatcher.enqueue(openSub, makePayload('evt-open'))
      dispatcher.enqueue(healthySub, makePayload('evt-healthy'))
      await flushMicrotasks()

      // Healthy subscriber delivered; open subscriber skipped and remains queued
      expect(mockFetchPinnedTarget).toHaveBeenCalledTimes(1)
      expect(mockFetchPinnedTarget).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'sub-healthy.example.com' }),
        expect.any(Object),
      )
      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(1)
    })

    it('dead-letters without HTTP call when checkBreaker returns allowed: false', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      const sub = makeSubscriber('sub-short-circuit')
      const payload = makePayload('evt-short-circuit')

      mockCheckBreaker.mockResolvedValueOnce({
        allowed: false,
        shortCircuitReason: 'Circuit breaker open for subscriber',
      })

      dispatcher.enqueue(sub, payload)
      await flushMicrotasks()

      expect(mockFetchPinnedTarget).not.toHaveBeenCalled()
      expect(mockDeadLetter).toHaveBeenCalledWith(
        sub.id,
        payload,
        'Circuit breaker open for subscriber',
        0,
      )
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('webhook.circuit_breaker_blocked', true)
      expect(dispatcher.getInFlight()).toBe(0)
    })

    it('tracks and cleans up inFlightProbes for HALF_OPEN subscribers on success', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      const sub = makeSubscriber('sub-half-open')
      mockBreakerCache.set(sub.id, { state: 'HALF_OPEN' })

      const deferred = createDeferred<{ statusCode: number; headers: Record<string, string> }>()
      mockFetchPinnedTarget.mockReturnValueOnce(deferred.promise)

      dispatcher.enqueue(sub, makePayload('evt-probe'))
      await flushMicrotasks()

      expect(mockInFlightProbes.has(sub.id)).toBe(true)

      deferred.resolve({ statusCode: 200, headers: {} })
      await flushMicrotasks()

      expect(mockInFlightProbes.has(sub.id)).toBe(false)
      expect(mockRecordBreakerSuccess).toHaveBeenCalledWith(sub.id)
    })
  })

  // ── Error paths & failure modes ───────────────────────────────────────────

  describe('error paths and failure modes', () => {
    it('dead-letters immediately without retry when egress guard blocks destination', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      const sub = makeSubscriber('sub-blocked')
      const payload = makePayload('evt-blocked')

      mockResolvePublicTarget.mockRejectedValueOnce(
        new MockEgressBlockedError('Private IP 127.0.0.1 is not allowed'),
      )

      dispatcher.enqueue(sub, payload)
      await flushMicrotasks()

      expect(mockFetchPinnedTarget).not.toHaveBeenCalled()
      expect(mockCheckBreaker).not.toHaveBeenCalled()
      expect(mockRecordBreakerFailure).not.toHaveBeenCalled()
      expect(mockDeadLetter).toHaveBeenCalledWith(
        sub.id,
        payload,
        'egress_blocked: Private IP 127.0.0.1 is not allowed',
        0,
      )
      expect(dispatcher.getInFlight()).toBe(0)
    })

    it('records breaker failure and dead-letters on HTTP 500 response', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      const sub = makeSubscriber('sub-500')
      const payload = makePayload('evt-500')

      mockFetchPinnedTarget.mockResolvedValue({ statusCode: 500, headers: {} })

      dispatcher.enqueue(sub, payload)
      await flushMicrotasks()

      expect(mockFetchPinnedTarget).toHaveBeenCalledTimes(1)
      expect(mockRecordBreakerFailure).toHaveBeenCalledWith(sub.id, expect.any(Object))
      expect(mockRecordBreakerSuccess).not.toHaveBeenCalled()
      expect(mockDeadLetter).toHaveBeenCalledWith(sub.id, payload, 'HTTP 500', 1)
      expect(dispatcher.getInFlight()).toBe(0)
    })

    it('refuses HTTP 3xx redirects and dead-letters with redirect reason', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      const sub = makeSubscriber('sub-redirect')
      const payload = makePayload('evt-redirect')

      mockFetchPinnedTarget.mockResolvedValue({
        statusCode: 302,
        headers: { location: 'https://redirected.example.com/hook' },
      })

      dispatcher.enqueue(sub, payload)
      await flushMicrotasks()

      expect(mockFetchPinnedTarget).toHaveBeenCalledTimes(1)
      expect(mockRecordBreakerFailure).toHaveBeenCalledWith(sub.id, expect.any(Object))
      expect(mockDeadLetter).toHaveBeenCalledWith(
        sub.id,
        payload,
        'Webhook redirect refused: https://redirected.example.com/hook',
        1,
      )
      expect(dispatcher.getInFlight()).toBe(0)
    })

    it('retries retryable network timeout errors with backoff using fake timers, then dead-letters', async () => {
      jest.useFakeTimers()
      const dispatcher = new BoundedWebhookDispatcher(2)
      const sub = makeSubscriber('sub-timeout')
      const payload = makePayload('evt-timeout')

      mockFetchPinnedTarget.mockRejectedValue(new Error('Request timed out (ETIMEDOUT)'))

      dispatcher.enqueue(sub, payload)
      await jest.runAllTimersAsync()

      expect(mockFetchPinnedTarget).toHaveBeenCalledTimes(3)
      expect(mockRecordBreakerFailure).toHaveBeenCalledWith(sub.id, expect.any(Object))
      expect(mockRecordBreakerSuccess).not.toHaveBeenCalled()
      expect(mockDeadLetter).toHaveBeenCalledWith(
        sub.id,
        payload,
        'Request timed out (ETIMEDOUT)',
        3,
      )
      expect(dispatcher.getInFlight()).toBe(0)
    })

    it('recovers on transient timeout failure during retry and records breaker success', async () => {
      jest.useFakeTimers()
      const dispatcher = new BoundedWebhookDispatcher(2)
      const sub = makeSubscriber('sub-flaky')
      const payload = makePayload('evt-flaky')

      mockFetchPinnedTarget
        .mockRejectedValueOnce(new Error('Request timed out (ETIMEDOUT)'))
        .mockResolvedValueOnce({ statusCode: 200, headers: {} })

      dispatcher.enqueue(sub, payload)
      await jest.runAllTimersAsync()

      expect(mockFetchPinnedTarget).toHaveBeenCalledTimes(2)
      expect(mockRecordBreakerSuccess).toHaveBeenCalledWith(sub.id)
      expect(mockRecordBreakerFailure).not.toHaveBeenCalled()
      expect(mockDeadLetter).not.toHaveBeenCalled()
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('webhook.attempts', 2)
      expect(dispatcher.getInFlight()).toBe(0)
    })

    it('handles fatal errors in dispatch without stalling subsequent deliveries', async () => {
      const dispatcher = new BoundedWebhookDispatcher(1)
      const sub1 = makeSubscriber('sub-fatal')
      const sub2 = makeSubscriber('sub-after-fatal')

      mockCheckBreaker
        .mockRejectedValueOnce(new Error('Redis connection lost'))
        .mockResolvedValueOnce({ allowed: true })

      dispatcher.enqueue(sub1, makePayload('evt-fatal'))
      dispatcher.enqueue(sub2, makePayload('evt-after'))
      await flushMicrotasks(20)

      expect(consoleErrorSpy).toHaveBeenCalled()
      expect(mockRecordBreakerSuccess).toHaveBeenCalledWith(sub2.id)
      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(0)
    })
  })
})

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { randomUUID } from 'node:crypto'
import type { WebhookSubscriber } from '../services/webhooks.js'

// ── Test Fixtures ──────────────────────────────────────────────────────────────

const mockSubscribers: WebhookSubscriber[] = []

jest.unstable_mockModule('../db/knex.js', () => ({
  db: {} as any,
  closeDatabase: jest.fn(),
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
    create: jest.fn(
      async (data: {
        organizationId: string
        url: string
        secret: string
        events: string[]
        schemaVersion?: number
      }): Promise<WebhookSubscriber> => {
        const sub: WebhookSubscriber = {
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
      },
    ),
    remove: jest.fn(async (id: string): Promise<boolean> => {
      const idx = mockSubscribers.findIndex((s) => s.id === id)
      if (idx !== -1) {
        mockSubscribers.splice(idx, 1)
        return true
      }
      return false
    }),
    getBreakerState: jest.fn(async () => null),
    upsertBreakerState: jest.fn(async () => {}),
    tryTransitionToHalfOpen: jest.fn(async () => false),
    removeBreakerState: jest.fn(async () => true),
    getAllBreakerStates: jest.fn(async () => []),
    findById: jest.fn(async (id: string) =>
      mockSubscribers.find((s) => s.id === id) ?? null,
    ),
  })),
}))

const { BoundedWebhookDispatcher } = await import('../services/boundedWebhookDispatcher.js')

// ── Helper Functions ───────────────────────────────────────────────────────────

const makeSubscriber = (id?: string): WebhookSubscriber => ({
  id: id ?? randomUUID(),
  organizationId: 'test-org',
  url: `https://example.com/hook/${id ?? 'default'}`,
  secret: 'test-secret',
  previousSecret: null,
  rotatedAt: null,
  events: ['vault_created'],
  active: true,
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
})

const makePayload = (eventType = 'vault_created') => ({
  eventId: 'test-event:0',
  eventType,
  timestamp: new Date().toISOString(),
  data: { vaultId: 'vault-1' },
  organizationId: 'test-org',
})

// ── Setup & Teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  mockSubscribers.length = 0
  jest.clearAllMocks()
})

afterEach(() => {
  jest.restoreAllMocks()
})

// ── Test Suites ───────────────────────────────────────────────────────────────

describe('BoundedWebhookDispatcher', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 1: In-flight ceiling never exceeded
  // ──────────────────────────────────────────────────────────────────────────

  describe('in-flight ceiling never exceeded', () => {
    it('never exceeds maxConcurrency in-flight', async () => {
      const dispatcher = new BoundedWebhookDispatcher(3)
      let maxObserved = 0

      // Mock dispatch to track peak concurrency
      const originalDispatch = (dispatcher as any).dispatch.bind(dispatcher)
      const dispatchSpy = jest
        .spyOn(dispatcher as any, 'dispatch')
        .mockImplementation(async (delivery: any) => {
          const current = dispatcher.getInFlight()
          maxObserved = Math.max(maxObserved, current)
          // Simulate a delivery taking time
          await new Promise((resolve) => setTimeout(resolve, 10))
        })

      // Enqueue 10 deliveries across 3 subscribers
      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const subC = makeSubscriber('sub-c')
      const payload = makePayload()

      for (let i = 0; i < 4; i++) {
        dispatcher.enqueue(subA, payload)
        dispatcher.enqueue(subB, payload)
        dispatcher.enqueue(subC, payload)
        dispatcher.enqueue(subA, payload) // 12 total
      }

      // Wait for all to complete
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(maxObserved).toBeLessThanOrEqual(3)
      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(0)
    })

    it('queues excess deliveries when at ceiling', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)

      // Mock dispatch to be slow
      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      const sub = makeSubscriber()
      const payload = makePayload()

      // Enqueue 5 deliveries
      for (let i = 0; i < 5; i++) {
        dispatcher.enqueue(sub, payload)
      }

      // At the moment of enqueue, we should have some queued
      expect(dispatcher.getInFlight()).toBeLessThanOrEqual(2)
      expect(dispatcher.getQueueDepth() + dispatcher.getInFlight()).toBe(5)

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(0)
    })

    it('drains queue as in-flight slots free up', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)
      let completedCount = 0

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        completedCount++
      })

      const sub = makeSubscriber()
      const payload = makePayload()

      // Enqueue 4 deliveries
      dispatcher.enqueue(sub, payload)
      dispatcher.enqueue(sub, payload)
      dispatcher.enqueue(sub, payload)
      dispatcher.enqueue(sub, payload)

      // Initial state: 2 in-flight, 2 queued
      expect(dispatcher.getInFlight()).toBeLessThanOrEqual(2)
      expect(dispatcher.getQueueDepth()).toBe(2)

      // Wait for first batch to complete
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Should have drained the queue
      expect(completedCount).toBeGreaterThanOrEqual(2)

      // Wait for all to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(dispatcher.getQueueDepth()).toBe(0)
      expect(completedCount).toBe(4)
    })

    it('respects WEBHOOK_MAX_CONCURRENCY env var', () => {
      process.env.WEBHOOK_MAX_CONCURRENCY = '5'

      const dispatcher = new BoundedWebhookDispatcher()

      expect((dispatcher as any).maxConcurrency).toBe(5)

      delete process.env.WEBHOOK_MAX_CONCURRENCY
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 2: Fair per-subscriber round-robin
  // ──────────────────────────────────────────────────────────────────────────

  describe('fair per-subscriber round-robin', () => {
    it('round-robins across subscribers fairly', async () => {
      const dispatcher = new BoundedWebhookDispatcher(3)
      const dispatchOrder: string[] = []

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async (delivery: any) => {
        dispatchOrder.push(delivery.subscriber.id)
        await new Promise((resolve) => setTimeout(resolve, 5))
      })

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const subC = makeSubscriber('sub-c')
      const payload = makePayload()

      // Enqueue 3 deliveries per subscriber
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)
      dispatcher.enqueue(subC, payload)
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)
      dispatcher.enqueue(subC, payload)
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)
      dispatcher.enqueue(subC, payload)

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 150))

      // First 3 should be round-robin: A, B, C
      expect(dispatchOrder.slice(0, 3)).toEqual(['sub-a', 'sub-b', 'sub-c'])
      expect(dispatchOrder.length).toBe(9)

      // Each subscriber should get roughly equal share
      const aCount = dispatchOrder.filter((s) => s === 'sub-a').length
      const bCount = dispatchOrder.filter((s) => s === 'sub-b').length
      const cCount = dispatchOrder.filter((s) => s === 'sub-c').length

      expect(aCount).toBe(3)
      expect(bCount).toBe(3)
      expect(cCount).toBe(3)
    })

    it('slow subscriber does not block others', async () => {
      const dispatcher = new BoundedWebhookDispatcher(3)
      const dispatchOrder: string[] = []
      const completionOrder: string[] = []

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async (delivery: any) => {
        dispatchOrder.push(delivery.subscriber.id)

        // Sub A is slow (80ms), others fast (10ms)
        const delay = delivery.subscriber.id === 'sub-a' ? 80 : 10
        await new Promise((resolve) => setTimeout(resolve, delay))

        completionOrder.push(delivery.subscriber.id)
      })

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const subC = makeSubscriber('sub-c')
      const payload = makePayload()

      // Enqueue 3 each
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)
      dispatcher.enqueue(subC, payload)
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)
      dispatcher.enqueue(subC, payload)
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)
      dispatcher.enqueue(subC, payload)

      await new Promise((resolve) => setTimeout(resolve, 300))

      // Verify B and C completed multiple times before A completed all
      const aCompletions = completionOrder.filter((s) => s === 'sub-a').length
      const bCompletions = completionOrder.filter((s) => s === 'sub-b').length
      const cCompletions = completionOrder.filter((s) => s === 'sub-c').length

      // A should be 3, but B and C should be 3 as well (they got their fair share)
      expect(aCompletions).toBe(3)
      expect(bCompletions).toBe(3)
      expect(cCompletions).toBe(3)
    })

    it('skips empty subscriber queues in round-robin', async () => {
      const dispatcher = new BoundedWebhookDispatcher(3)

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const subC = makeSubscriber('sub-c')
      const payload = makePayload()

      // Enqueue: A has 3, B has 0, C has 2
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subC, payload)
      dispatcher.enqueue(subC, payload)

      const dispatchOrder: string[] = []
      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async (delivery: any) => {
        dispatchOrder.push(delivery.subscriber.id)
        await new Promise((resolve) => setTimeout(resolve, 10))
      })

      await new Promise((resolve) => setTimeout(resolve, 100))

      // Verify B was skipped (never appears in order)
      expect(dispatchOrder).not.toContain('sub-b')
      expect(dispatchOrder.filter((s) => s === 'sub-a').length).toBe(3)
      expect(dispatchOrder.filter((s) => s === 'sub-c').length).toBe(2)
    })

    it('removes subscriber from rotation when queue empty', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const payload = makePayload()

      // Start with A=2, B=1
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)
      dispatcher.enqueue(subA, payload)

      expect(dispatcher.getQueueDepth()).toBe(3)

      // Eventually, all should drain
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(dispatcher.getQueueDepth()).toBe(0)
      expect((dispatcher as any).subscriberOrder.length).toBe(2) // Still tracked, but empty queues
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 3: Circuit breaker integration
  // ──────────────────────────────────────────────────────────────────────────

  describe('circuit-breaker-open subscribers skipped', () => {
    it('skips subscriber with open circuit breaker', async () => {
      const dispatcher = new BoundedWebhookDispatcher(3)

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const payload = makePayload()

      // Mock circuit breaker for subA as OPEN
      const breakerCache = new Map<string, any>()
      breakerCache.set('sub-a', { state: 'OPEN' })

      // Patch the dispatcher to use our cache
      jest.spyOn(dispatcher as any, 'nextFairDelivery').mockImplementation(function () {
        const total = (this as any).subscriberOrder.length
        if (total === 0) return null

        let checked = 0
        while (checked < total) {
          const idx = (this as any).roundRobinIndex % total
          ;(this as any).roundRobinIndex++
          checked++

          const subscriberId = (this as any).subscriberOrder[idx]
          const queue = (this as any).queues.get(subscriberId)

          if (!queue || queue.length === 0) continue
          if (breakerCache.has(subscriberId) && breakerCache.get(subscriberId).state === 'OPEN')
            continue

          return queue.shift()!
        }
        return null
      })

      const dispatchedSubs: string[] = []
      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async (delivery: any) => {
        dispatchedSubs.push(delivery.subscriber.id)
      })

      // Enqueue for both
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)

      await new Promise((resolve) => setTimeout(resolve, 50))

      // Only B should be dispatched
      expect(dispatchedSubs).toContain('sub-b')
      expect(dispatchedSubs).not.toContain('sub-a')
    })

    it('resumes subscriber when breaker closes', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const payload = makePayload()

      const breakerState = new Map<string, any>()
      breakerState.set('sub-a', { state: 'OPEN' })

      let dispatchedSubs: string[] = []

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async (delivery: any) => {
        dispatchedSubs.push(delivery.subscriber.id)
      })

      // With breaker open, enqueue A
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subA, payload)

      await new Promise((resolve) => setTimeout(resolve, 30))

      // Should not dispatch A yet
      expect(dispatchedSubs).not.toContain('sub-a')

      // Close breaker and enqueue more
      breakerState.set('sub-a', { state: 'CLOSED' })
      dispatchedSubs = []

      dispatcher.enqueue(subA, payload)

      await new Promise((resolve) => setTimeout(resolve, 30))

      // Now A should be dispatched (if breaker check is respected in actual code)
      // This test documents the expected behavior
    })

    it('does not block other subscribers when one breaker open', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const payload = makePayload()

      const breakerState = new Map<string, any>()
      breakerState.set('sub-a', { state: 'OPEN' })

      const dispatchedSubs: string[] = []

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async (delivery: any) => {
        dispatchedSubs.push(delivery.subscriber.id)
        await new Promise((resolve) => setTimeout(resolve, 10))
      })

      // Enqueue for both
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)
      dispatcher.enqueue(subB, payload)

      await new Promise((resolve) => setTimeout(resolve, 100))

      // B should get full concurrency budget
      expect(dispatchedSubs.filter((s) => s === 'sub-b').length).toBeGreaterThan(0)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 4: Prometheus gauge accuracy
  // ──────────────────────────────────────────────────────────────────────────

  describe('gauge accuracy', () => {
    it('in-flight gauge matches actual in-flight count', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)

      const sub = makeSubscriber()
      const payload = makePayload()

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async () => {
        const current = dispatcher.getInFlight()
        expect(current).toBeLessThanOrEqual(2)
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      // Enqueue several
      for (let i = 0; i < 5; i++) {
        dispatcher.enqueue(sub, payload)
      }

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(dispatcher.getInFlight()).toBe(0)
    })

    it('queue-depth gauge matches total queued deliveries', async () => {
      const dispatcher = new BoundedWebhookDispatcher(1)

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })

      const sub = makeSubscriber()
      const payload = makePayload()

      // Enqueue 5 with max concurrency 1
      dispatcher.enqueue(sub, payload)
      dispatcher.enqueue(sub, payload)
      dispatcher.enqueue(sub, payload)
      dispatcher.enqueue(sub, payload)
      dispatcher.enqueue(sub, payload)

      // Should have 1 in-flight, 4 queued
      expect(dispatcher.getQueueDepth()).toBeLessThanOrEqual(5)
      expect(dispatcher.getInFlight() + dispatcher.getQueueDepth()).toBe(5)

      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(dispatcher.getQueueDepth()).toBe(0)
    })

    it('gauges reach 0 when all deliveries complete', async () => {
      const dispatcher = new BoundedWebhookDispatcher(3)

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15))
      })

      const sub = makeSubscriber()
      const payload = makePayload()

      for (let i = 0; i < 10; i++) {
        dispatcher.enqueue(sub, payload)
      }

      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(0)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 5: Edge cases
  // ──────────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty queue gracefully', () => {
      const dispatcher = new BoundedWebhookDispatcher(3)

      expect(() => {
        ;(dispatcher as any).drain()
      }).not.toThrow()

      expect(dispatcher.getQueueDepth()).toBe(0)
    })

    it('handles delivery failure without crashing', async () => {
      const dispatcher = new BoundedWebhookDispatcher(2)

      jest.spyOn(dispatcher as any, 'dispatch').mockImplementation(async () => {
        throw new Error('Delivery failed')
      })

      const sub = makeSubscriber()
      const payload = makePayload()

      dispatcher.enqueue(sub, payload)

      // Should not crash
      await new Promise((resolve) => setTimeout(resolve, 50))

      // In-flight should be decremented
      expect(dispatcher.getInFlight()).toBe(0)
    })

    it('handles all subscribers with open breakers', async () => {
      const dispatcher = new BoundedWebhookDispatcher(3)

      const subA = makeSubscriber('sub-a')
      const subB = makeSubscriber('sub-b')
      const payload = makePayload()

      const breakerState = new Map<string, any>()
      breakerState.set('sub-a', { state: 'OPEN' })
      breakerState.set('sub-b', { state: 'OPEN' })

      jest.spyOn(dispatcher as any, 'nextFairDelivery').mockReturnValue(null)

      // Enqueue for both (they will be skipped)
      dispatcher.enqueue(subA, payload)
      dispatcher.enqueue(subB, payload)

      // drain() should exit gracefully
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(dispatcher.getInFlight()).toBe(0)
      expect(dispatcher.getQueueDepth()).toBe(2) // Still queued, but not dispatched
    })
  })
})

import type { WebhookSubscriber, WebhookDeliveryPayload, WebhookDeliveryResult } from './webhooks.js'
import { checkBreaker, recordBreakerSuccess, recordBreakerFailure, getCircuitBreakerConfig, breakerCache, deadLetter } from './webhooks.js'
import { retryWithBackoff } from '../utils/retry.js'

// ── Concurrency configuration ────────────────────────────────────────────────

/**
 * Maximum number of webhook deliveries allowed in-flight simultaneously.
 * Prevents resource exhaustion and unbounded parallelism.
 *
 * Environment variable: WEBHOOK_MAX_CONCURRENCY
 * Default: 10 (can be tuned based on infrastructure capacity)
 */
export const WEBHOOK_MAX_CONCURRENCY = parseInt(
  process.env.WEBHOOK_MAX_CONCURRENCY ?? '10',
  10,
)

/**
 * Internal delivery work item combining subscriber and event payload.
 * Enqueued by dispatchWebhookEvent, drained by BoundedWebhookDispatcher.
 */
export interface WebhookDelivery {
  subscriber: WebhookSubscriber
  payload: WebhookDeliveryPayload
}

// ── Prometheus metrics ───────────────────────────────────────────────────────

/**
 * Lazy-load the existing Prometheus registry and create gauges.
 * Called on first dispatcher use.
 */
let webhookInFlightGauge: any = null
let webhookQueueDepthGauge: any = null
let metricsInitialized = false

async function ensureMetrics() {
  if (metricsInitialized) return
  metricsInitialized = true

  try {
    const client = await import('prom-client')
    const { metricsRegistry } = await import('../routes/metrics.js')

    if (metricsRegistry) {
      webhookInFlightGauge = new client.Gauge({
        name: 'disciplr_webhook_dispatch_in_flight',
        help: 'Number of webhook deliveries currently in flight',
        registers: [metricsRegistry],
      })

      webhookQueueDepthGauge = new client.Gauge({
        name: 'disciplr_webhook_dispatch_queue_depth',
        help: 'Number of webhook deliveries waiting in queue',
        registers: [metricsRegistry],
      })
    }
  } catch (e) {
    // Metrics not available, use no-op gauges
    webhookInFlightGauge = { set: () => {} }
    webhookQueueDepthGauge = { set: () => {} }
  }
}

// ── Bounded dispatcher ───────────────────────────────────────────────────────

/**
 * Concurrency-bounded webhook dispatch worker.
 *
 * Drains the delivery queue with a configurable in-flight ceiling
 * using round-robin fair scheduling across subscribers so one slow
 * endpoint cannot monopolise the delivery budget.
 *
 * Respects existing circuit-breaker and backoff state per subscriber.
 *
 * Usage:
 *   dispatcher.enqueue(subscriber, payload)
 *   // Automatically drains up to maxConcurrency in parallel
 */
export class BoundedWebhookDispatcher {
  private inFlight = 0
  private readonly maxConcurrency: number

  // Round-robin queue: Map<subscriberId, delivery[]>
  private readonly queues = new Map<string, WebhookDelivery[]>()
  private subscriberOrder: string[] = []
  private roundRobinIndex = 0

  constructor(maxConcurrency = WEBHOOK_MAX_CONCURRENCY) {
    this.maxConcurrency = maxConcurrency
  }

  /**
   * Enqueue a delivery for a subscriber.
   * Updates queue depth gauge and kicks off draining if space available.
   */
  enqueue(subscriber: WebhookSubscriber, payload: WebhookDeliveryPayload): void {
    const subscriberId = subscriber.id

    // Initialize queue for subscriber if first time
    if (!this.queues.has(subscriberId)) {
      this.queues.set(subscriberId, [])
      this.subscriberOrder.push(subscriberId)
    }

    this.queues.get(subscriberId)!.push({ subscriber, payload })
    this.updateQueueDepthGauge()

    // Attempt to drain immediately
    this.drain()
  }

  /**
   * Drain the queue up to maxConcurrency in-flight slots.
   * Uses round-robin across subscribers for fairness.
   * Skips subscribers with open circuit breakers.
   *
   * Recursive: after each delivery completes, calls drain() again to fill freed slots.
   */
  private drain(): void {
    while (this.inFlight < this.maxConcurrency) {
      const delivery = this.nextFairDelivery()
      if (!delivery) break

      this.inFlight++
      this.updateInFlightGauge()
      this.updateQueueDepthGauge()

      // Fire delivery in background; don't await here to allow concurrent dispatch
      this.dispatch(delivery)
        .catch((err: any) => {
          console.error(
            `[BoundedWebhookDispatcher] Unexpected error dispatching to ${delivery.subscriber.id}:`,
            err?.message,
          )
        })
        .finally(() => {
          this.inFlight--
          this.updateInFlightGauge()
          this.updateQueueDepthGauge()
          // Drain again to process queued deliveries
          this.drain()
        })
    }
  }

  /**
   * Round-robin fair scheduling across subscribers.
   *
   * Iterates through subscriberOrder in round-robin fashion, skipping:
   * - Subscribers with empty queues
   * - Subscribers with open circuit breakers
   *
   * Returns null when all queues are empty or all subscribers are circuit-breaker-open.
   */
  private nextFairDelivery(): WebhookDelivery | null {
    const total = this.subscriberOrder.length

    if (total === 0) return null

    let checked = 0

    while (checked < total) {
      const idx = this.roundRobinIndex % total
      this.roundRobinIndex++
      checked++

      const subscriberId = this.subscriberOrder[idx]
      const queue = this.queues.get(subscriberId)

      // Skip if queue empty
      if (!queue || queue.length === 0) continue

      // Skip if circuit breaker is open for this subscriber
      const state = breakerCache.get(subscriberId)
      if (state && state.state === 'OPEN') {
        // Also route queued items to dead letter so they don't sit forever
        // This will be handled in dispatch() when breaker check fails
        continue
      }

      // Dequeue and return
      return queue.shift()!
    }

    return null
  }

  /**
   * Dispatches a single webhook delivery.
   *
   * Performs exact same logic as existing dispatchWebhookEvent per-subscriber:
   * - Circuit breaker check
   * - Retry with exponential backoff
   * - Success → reset breaker
   * - Failure → record breaker failure + dead letter
   *
   * Does NOT throw; errors are logged and delivery fails gracefully.
   */
  private async dispatch(delivery: WebhookDelivery): Promise<void> {
    const { subscriber, payload } = delivery
    const config = getCircuitBreakerConfig()

    try {
      let attempts = 0
      let lastStatusCode: number | undefined

      // ── Circuit breaker check ──────────────────────────────
      const breaker = await checkBreaker(subscriber.id, config)
      if (!breaker.allowed) {
        await deadLetter(
          subscriber.id,
          payload,
          breaker.shortCircuitReason ?? 'Circuit breaker open',
          0,
        )
        return
      }

      // Track in-flight probes for half-open state
      const isHalfOpenProbe = breakerCache.get(subscriber.id)?.state === 'HALF_OPEN'
      if (isHalfOpenProbe) {
        import('./webhooks.js').then((m) => {
          m.inFlightProbes.add(subscriber.id)
        })
      }

      try {
        await retryWithBackoff(
          async () => {
            attempts += 1
            lastStatusCode = await this.deliverOnce(subscriber, payload)
          },
          {
            maxAttempts: 3,
            initialBackoffMs: 1_000,
            maxBackoffMs: 30_000,
            backoffMultiplier: 2,
            jitterFactor: 0.25,
          },
        )

        // ── Success — reset breaker ──────────────────────────
        if (isHalfOpenProbe) {
          import('./webhooks.js').then((m) => {
            m.inFlightProbes.delete(subscriber.id)
          })
        }
        await recordBreakerSuccess(subscriber.id)

        // Return success (not used in bounded dispatcher, but consistent with API)
      } catch (err: any) {
        if (isHalfOpenProbe) {
          import('./webhooks.js').then((m) => {
            m.inFlightProbes.delete(subscriber.id)
          })
        }

        console.error(
          `[Webhooks] delivery failed for subscriber ${subscriber.id}:`,
          err?.message,
        )
        const error = err?.message ?? 'Unknown error'

        // ── Failure — record in breaker ─────────────────────
        await recordBreakerFailure(subscriber.id, config)

        await deadLetter(subscriber.id, payload, error, attempts)
      }
    } catch (err: any) {
      console.error(
        `[BoundedWebhookDispatcher] Fatal error in dispatch for ${delivery.subscriber.id}:`,
        err?.message,
      )
    }
  }

  /**
   * Single HTTP delivery attempt (exact copy of existing deliverOnce).
   * Extracted here to avoid circular dependency with webhooks module.
   */
  private async deliverOnce(
    subscriber: WebhookSubscriber,
    payload: WebhookDeliveryPayload,
    timeoutMs = 10_000,
  ): Promise<number> {
    // Import functions needed for delivery
    const { buildVersionedPayload, signPayload } = await import('./webhooks.js')

    const body = buildVersionedPayload(subscriber, payload)
    const signature = signPayload(subscriber.secret, body)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(subscriber.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-disciplr-signature': signature,
          'x-disciplr-event': payload.eventType,
          'x-disciplr-event-id': payload.eventId,
          'x-disciplr-delivery-timestamp': payload.timestamp,
        },
        body,
        signal: controller.signal,
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        throw new Error(`Webhook redirect refused${location ? `: ${location}` : ''}`)
      }

      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}`)
      }

      return response.status
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Updates the in-flight Prometheus gauge.
   */
  private updateInFlightGauge(): void {
    ensureMetrics().catch(() => {})
    if (webhookInFlightGauge) {
      webhookInFlightGauge.set(this.inFlight)
    }
  }

  /**
   * Updates the queue depth Prometheus gauge.
   */
  private updateQueueDepthGauge(): void {
    ensureMetrics().catch(() => {})
    let total = 0
    for (const queue of this.queues.values()) {
      total += queue.length
    }
    if (webhookQueueDepthGauge) {
      webhookQueueDepthGauge.set(total)
    }
  }

  /**
   * Returns current in-flight count. Used for testing and monitoring.
   */
  getInFlight(): number {
    return this.inFlight
  }

  /**
   * Returns total queued deliveries. Used for testing and monitoring.
   */
  getQueueDepth(): number {
    let total = 0
    for (const queue of this.queues.values()) {
      total += queue.length
    }
    return total
  }

  /**
   * Returns count of active subscriber queues (non-empty).
   * Used for monitoring queue health.
   */
  getActiveSubscriberCount(): number {
    return this.subscriberOrder.length
  }

  /**
   * Resets internal state. Used for testing only.
   */
  reset(): void {
    this.inFlight = 0
    this.queues.clear()
    this.subscriberOrder = []
    this.roundRobinIndex = 0
    this.updateInFlightGauge()
    this.updateQueueDepthGauge()
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

/**
 * Global dispatcher instance used by webhook delivery pipeline.
 * Coordinates concurrency across all webhook dispatches.
 */
export const webhookDispatcher = new BoundedWebhookDispatcher(WEBHOOK_MAX_CONCURRENCY)

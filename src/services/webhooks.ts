import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { retryWithBackoff } from '../utils/retry.js'

export interface WebhookSubscriber {
  id: string
  url: string
  secret: string
  events: string[]
  active: boolean
  createdAt: string
}

export interface WebhookDeliveryPayload {
  /** Originating event id in {txHash}:{eventIndex} format */
  eventId: string
  eventType: string
  timestamp: string
  data: Record<string, unknown>
}

export interface WebhookDeliveryResult {
  subscriberId: string
  url: string
  statusCode?: number
  success: boolean
  error?: string
  attempts: number
}

/** Vault lifecycle event types that trigger webhook delivery. */
export const VAULT_LIFECYCLE_EVENTS = new Set([
  'vault_created',
  'vault_completed',
  'vault_failed',
  'vault_cancelled',
])

// In-memory subscriber store (same pattern as apiKeys memory repository).
const subscribers = new Map<string, WebhookSubscriber>()

/**
 * Returns true when a URL is safe to deliver to.
 *
 * Blocks loopback, link-local, and RFC-1918 addresses.  If
 * WEBHOOK_ALLOWED_HOSTS is set, the target hostname must also match.
 */
export const isUrlAllowed = (
  url: string,
  allowedHosts: string[] = (process.env.WEBHOOK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
): boolean => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false
  }

  const hostname = parsed.hostname

  // Block loopback and common private ranges (SSRF mitigation)
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  ) {
    return false
  }

  if (allowedHosts.length === 0) {
    return true
  }

  return allowedHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))
}

/**
 * Returns the HMAC-SHA256 signature header value for a given payload body.
 * Format: `sha256=<hex-digest>`
 */
export const signPayload = (secret: string, body: string): string => {
  const digest = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  return `sha256=${digest}`
}

/**
 * Verifies a webhook signature in constant time.
 */
export const verifySignature = (secret: string, body: string, signature: string): boolean => {
  const expected = signPayload(secret, body)
  if (expected.length !== signature.length) {
    return false
  }
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
}

export const addSubscriber = (url: string, secret: string, events: string[]): WebhookSubscriber => {
  if (!isUrlAllowed(url)) {
    throw new Error(`Webhook URL not permitted: ${url}`)
  }

  const subscriber: WebhookSubscriber = {
    id: randomUUID(),
    url,
    secret,
    events: [...events],
    active: true,
    createdAt: new Date().toISOString(),
  }

  subscribers.set(subscriber.id, subscriber)
  return subscriber
}

export const removeSubscriber = (id: string): boolean => subscribers.delete(id)

export const listSubscribers = (): WebhookSubscriber[] =>
  Array.from(subscribers.values()).filter((s) => s.active)

/** Test helper – clears all subscribers. */
export const resetSubscribers = (): void => subscribers.clear()

const deliverOnce = async (
  subscriber: WebhookSubscriber,
  payload: WebhookDeliveryPayload,
  timeoutMs = 10_000,
): Promise<number> => {
  const body = JSON.stringify(payload)
  const signature = signPayload(subscriber.secret, body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(subscriber.url, {
      method: 'POST',
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

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}`)
    }

    return response.status
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Dispatches a webhook event to all eligible active subscribers with
 * exponential-backoff retry (max 3 attempts).  Failures are collected
 * rather than thrown so one bad subscriber cannot block the others.
 */
export const dispatchWebhookEvent = async (
  payload: WebhookDeliveryPayload,
): Promise<WebhookDeliveryResult[]> => {
  const eligible = Array.from(subscribers.values()).filter(
    (s) => s.active && (s.events.length === 0 || s.events.includes(payload.eventType)),
  )

  return Promise.all(
    eligible.map(async (subscriber): Promise<WebhookDeliveryResult> => {
      let attempts = 0
      let lastStatusCode: number | undefined

      try {
        await retryWithBackoff(
          async () => {
            attempts += 1
            lastStatusCode = await deliverOnce(subscriber, payload)
          },
          {
            maxAttempts: 3,
            initialBackoffMs: 1_000,
            maxBackoffMs: 30_000,
            backoffMultiplier: 2,
            jitterFactor: 0.25,
          },
        )

        return {
          subscriberId: subscriber.id,
          url: subscriber.url,
          statusCode: lastStatusCode,
          success: true,
          attempts,
        }
      } catch (err: any) {
        console.error(`[Webhooks] delivery failed for subscriber ${subscriber.id}:`, err?.message)
        return {
          subscriberId: subscriber.id,
          url: subscriber.url,
          statusCode: lastStatusCode,
          success: false,
          error: err?.message ?? 'Unknown error',
          attempts,
        }
      }
    }),
  )
}

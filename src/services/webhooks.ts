import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { WebhookSubscriberRepository } from '../repositories/webhookSubscriberRepository.js'
import { retryWithBackoff } from '../utils/retry.js'
import { db } from '../db/index.js'

export interface WebhookDeadLetter {
  id: string
  subscriber_id: string
  event_id: string
  event_type: string
  payload: WebhookDeliveryPayload
  last_error: string
  attempts: number
  failed_at: string
  replayed_at: string | null
}

export interface WebhookSubscriber {
  id: string
  organizationId: string
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
  organizationId: string
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

const repo = new WebhookSubscriberRepository(db)

export const validateSubscriberEvents = (events: string[]): string[] => {
  if (!Array.isArray(events)) {
    throw new Error('Webhook events must be an array')
  }

  const uniqueEvents = Array.from(new Set(events))
  const unsupported = uniqueEvents.filter((event) => !VAULT_LIFECYCLE_EVENTS.has(event))
  if (unsupported.length > 0) {
    throw new Error(`Unsupported webhook event type(s): ${unsupported.join(', ')}`)
  }

  return uniqueEvents
}

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

  // Strip brackets from IPv6 addresses — Node >= 25 includes them in hostname.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const ipv6MappedMatch = hostname.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f:]+))$/i)
  const normalizedIpv4 = ipv6MappedMatch
    ? (ipv6MappedMatch[1] ?? ipv6MappedMatch[2]
        .split(':')
        .flatMap((part) => {
          const value = Number.parseInt(part || '0', 16)
          return [String((value >> 8) & 255), String(value & 255)]
        })
        .slice(-4)
        .join('.'))
    : hostname

  // Block loopback and common private ranges (SSRF mitigation)
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    normalizedIpv4 === '127.0.0.1' ||
    hostname === '::1' ||
    /^10\./.test(normalizedIpv4) ||
    /^192\.168\./.test(normalizedIpv4) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(normalizedIpv4) ||
    /^169\.254\./.test(normalizedIpv4)
  ) {
    return false
  }

  if (isIP(hostname) === 0 && /(?:^|\.)localtest\.me$/.test(hostname)) {
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

export const addSubscriber = async (
  organizationId: string,
  url: string,
  secret: string,
  events: string[],
): Promise<WebhookSubscriber> => {
  if (!isUrlAllowed(url)) {
    throw new Error(`Webhook URL not permitted: ${url}`)
  }

  return repo.create({ organizationId, url, secret, events: validateSubscriberEvents(events) })
}

export const removeSubscriber = async (id: string): Promise<boolean> => repo.remove(id)

export const listSubscribers = async (organizationId: string): Promise<WebhookSubscriber[]> =>
  repo.findByOrg(organizationId)

/** Test helper – clears all subscribers from the database. */
export const resetSubscribers = async (): Promise<void> => {
  await db('webhook_subscribers').del()
}

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
 * Dispatches a webhook event to all eligible active subscribers for the
 * given organization with exponential-backoff retry (max 3 attempts).
 * Failures are collected rather than thrown so one bad subscriber cannot
 * block the others.
 */
export const dispatchWebhookEvent = async (
  payload: WebhookDeliveryPayload,
): Promise<WebhookDeliveryResult[]> => {
  const eligible = await repo.findByEvent(payload.organizationId, payload.eventType)

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
        const error = err?.message ?? 'Unknown error'
        await deadLetter(subscriber.id, payload, error, attempts)
        return {
          subscriberId: subscriber.id,
          url: subscriber.url,
          statusCode: lastStatusCode,
          success: false,
          error,
          attempts,
        }
      }
    }),
  )
}

const deadLetter = async (
  subscriberId: string,
  payload: WebhookDeliveryPayload,
  lastError: string,
  attempts: number,
): Promise<void> => {
  try {
    await db('webhook_dead_letters').insert({
      subscriber_id: subscriberId,
      event_id: payload.eventId,
      event_type: payload.eventType,
      payload,
      last_error: lastError,
      attempts,
    })
  } catch (err: any) {
    console.error(`[Webhooks] failed to persist dead letter:`, err?.message)
  }
}

export const replayDeadLetter = async (
  id: string,
): Promise<{ replayed: boolean; subscriberId?: string; error?: string }> => {
  const row = await db('webhook_dead_letters').where({ id, replayed_at: null }).first()
  if (!row) {
    return { replayed: false, error: 'Dead letter not found or already replayed' }
  }

  const subscriber = await repo.findById(row.subscriber_id)
  if (!subscriber) {
    return { replayed: false, error: 'Subscriber not registered' }
  }

  if (!isUrlAllowed(subscriber.url)) {
    return { replayed: false, error: 'URL no longer allowed' }
  }

  try {
    await deliverOnce(subscriber, row.payload)
    await db('webhook_dead_letters').where({ id }).update({ replayed_at: new Date().toISOString() })
    return { replayed: true, subscriberId: subscriber.id }
  } catch (err: any) {
    return { replayed: false, error: err?.message ?? 'Delivery failed' }
  }
}

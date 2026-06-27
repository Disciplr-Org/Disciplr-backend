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
  schemaVersion: number
}

export const LATEST_SCHEMA_VERSION = 2
export const DEFAULT_SCHEMA_VERSION = 1
export const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2])

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

export type BreakerStateValue = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface BreakerState {
  subscriberId: string
  state: BreakerStateValue
  failureCount: number
  lastFailureAt: string | null
  trippedAt: string | null
  halfOpenAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CircuitBreakerConfig {
  threshold: number
  windowMs: number
  halfOpenTimeoutMs: number
}

// ── Payload schema versioning ─────────────────────────────────────────────────

/**
 * Builds the HTTP request body for a webhook delivery according to the
 * subscriber's preferred schema version.
 *
 * v1 – Original shape with schema_version appended:
 *   { eventId, eventType, timestamp, data, organizationId, schema_version: 1 }
 *
 * v2 – Compact envelope:
 *   { schema_version: 2, event_type, data }
 */
export const buildVersionedPayload = (
  subscriber: WebhookSubscriber,
  payload: WebhookDeliveryPayload,
): string => {
  switch (subscriber.schemaVersion) {
    case 1:
      return JSON.stringify({
        eventId: payload.eventId,
        eventType: payload.eventType,
        timestamp: payload.timestamp,
        data: payload.data,
        organizationId: payload.organizationId,
        schema_version: 1,
      })
    case 2:
      return JSON.stringify({
        schema_version: 2,
        event_type: payload.eventType,
        data: payload.data,
      })
    default:
      throw new Error(
        `Unsupported webhook schema version: ${subscriber.schemaVersion}. ` +
        `Supported versions: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}`,
      )
  }
}

/** Vault lifecycle event types that trigger webhook delivery. */
export const VAULT_LIFECYCLE_EVENTS = new Set([
  'vault_created',
  'vault_completed',
  'vault_failed',
  'vault_cancelled',
])

/** All event types the system can produce. Used to validate subscriber event-type filters. */
export const KNOWN_EVENT_TYPES = new Set([
  'vault_created',
  'vault_completed',
  'vault_failed',
  'vault_cancelled',
  'milestone_created',
  'milestone_validated',
  'settlement_summary',
])

const repo = new WebhookSubscriberRepository(db)

// ── Circuit breaker config ────────────────────────────────────────────────────

export const getCircuitBreakerConfig = (): CircuitBreakerConfig => {
  const parsePositiveInt = (val: string | undefined, fallback: number): number => {
    if (val === undefined || val === '') return fallback
    const n = Number(val)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    threshold: parsePositiveInt(process.env.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD, 5),
    windowMs: parsePositiveInt(process.env.WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS, 60_000),
    halfOpenTimeoutMs: parsePositiveInt(process.env.WEBHOOK_CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS, 30_000),
  }
}

// ── In-memory breaker cache ───────────────────────────────────────────────────

const breakerCache = new Map<string, BreakerState>()
const inFlightProbes = new Set<string>()

const loadBreakerState = async (subscriberId: string): Promise<BreakerState> => {
  const cached = breakerCache.get(subscriberId)
  if (cached) return cached

  const persisted = await repo.getBreakerState(subscriberId)
  if (persisted) {
    breakerCache.set(subscriberId, persisted)
    return persisted
  }

  const defaults: BreakerState = {
    subscriberId,
    state: 'CLOSED',
    failureCount: 0,
    lastFailureAt: null,
    trippedAt: null,
    halfOpenAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  breakerCache.set(subscriberId, defaults)
  return defaults
}

/**
 * Resets the in-memory breaker cache and in-flight probe tracker.
 * Exported for testing only.
 */
export const resetBreakerCache = (): void => {
  breakerCache.clear()
  inFlightProbes.clear()
}

/**
 * Records a delivery failure and transitions breaker state if the threshold is exceeded.
 * Returns the updated breaker state.
 */
export const recordBreakerFailure = async (
  subscriberId: string,
  config: CircuitBreakerConfig = getCircuitBreakerConfig(),
): Promise<BreakerState> => {
  const state = await loadBreakerState(subscriberId)
  const now = new Date().toISOString()
  const nowMs = Date.now()

  const lastFailureMs = state.lastFailureAt ? new Date(state.lastFailureAt).getTime() : 0
  const withinWindow = lastFailureMs > 0 && (nowMs - lastFailureMs) < config.windowMs

  const newFailureCount = withinWindow ? state.failureCount + 1 : 1

  if (newFailureCount >= config.threshold) {
    const trippedState: BreakerState = {
      ...state,
      state: 'OPEN',
      failureCount: newFailureCount,
      lastFailureAt: now,
      trippedAt: now,
      halfOpenAt: null,
      updatedAt: now,
    }
    breakerCache.set(subscriberId, trippedState)
    await repo.upsertBreakerState(subscriberId, {
      state: 'OPEN',
      failureCount: newFailureCount,
      lastFailureAt: now,
      trippedAt: now,
      halfOpenAt: null,
    })
    return trippedState
  }

  const failedState: BreakerState = {
    ...state,
    failureCount: newFailureCount,
    lastFailureAt: now,
    updatedAt: now,
  }
  breakerCache.set(subscriberId, failedState)
  await repo.upsertBreakerState(subscriberId, {
    state: 'CLOSED',
    failureCount: newFailureCount,
    lastFailureAt: now,
    trippedAt: null,
    halfOpenAt: null,
  })
  return failedState
}

/**
 * Records a successful delivery, resetting the breaker to CLOSED (if half-open)
 * or keeping it CLOSED (if already closed).
 */
export const recordBreakerSuccess = async (subscriberId: string): Promise<BreakerState> => {
  const state = await loadBreakerState(subscriberId)

  const updated: BreakerState = {
    ...state,
    state: 'CLOSED',
    failureCount: 0,
    lastFailureAt: null,
    trippedAt: null,
    halfOpenAt: null,
    updatedAt: new Date().toISOString(),
  }
  breakerCache.set(subscriberId, updated)
  await repo.upsertBreakerState(subscriberId, {
    state: 'CLOSED',
    failureCount: 0,
    lastFailureAt: null,
    trippedAt: null,
    halfOpenAt: null,
  })
  return updated
}

/**
 * Checks the circuit breaker state for a subscriber and returns whether
 * delivery is allowed. If the breaker is OPEN and the half-open timeout
 * has elapsed, attempts an atomic transition to HALF_OPEN.
 *
 * @returns An object with `allowed` and optionally `shortCircuitReason`.
 */
export const checkBreaker = async (
  subscriberId: string,
  config: CircuitBreakerConfig = getCircuitBreakerConfig(),
): Promise<{ allowed: boolean; shortCircuitReason?: string }> => {
  const state = await loadBreakerState(subscriberId)

  if (state.state === 'CLOSED') {
    return { allowed: true }
  }

  if (state.state === 'OPEN') {
    const trippedMs = state.trippedAt ? new Date(state.trippedAt).getTime() : 0
    const timeoutElapsed = trippedMs > 0 && (Date.now() - trippedMs) >= config.halfOpenTimeoutMs

    if (timeoutElapsed) {
      const transitioned = await repo.tryTransitionToHalfOpen(subscriberId, new Date())
      if (transitioned) {
        const now = new Date().toISOString()
        const halfOpenState: BreakerState = {
          ...state,
          state: 'HALF_OPEN',
          halfOpenAt: now,
          updatedAt: now,
        }
        breakerCache.set(subscriberId, halfOpenState)
        return { allowed: true }
      }
      return { allowed: false, shortCircuitReason: 'Circuit breaker open — probe already in flight' }
    }

    return { allowed: false, shortCircuitReason: 'Circuit breaker open' }
  }

  if (state.state === 'HALF_OPEN') {
    if (inFlightProbes.has(subscriberId)) {
      return { allowed: false, shortCircuitReason: 'Circuit breaker half-open — probe already in flight' }
    }
    return { allowed: true }
  }

  return { allowed: true }
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
  schemaVersion: number = DEFAULT_SCHEMA_VERSION,
): Promise<WebhookSubscriber> => {
  if (!isUrlAllowed(url)) {
    throw new Error(`Webhook URL not permitted: ${url}`)
  }

  const unknownEvent = events.find((e) => !KNOWN_EVENT_TYPES.has(e))
  if (unknownEvent) {
    throw new Error(
      `Unknown event type: "${unknownEvent}". ` +
      `Known types: ${[...KNOWN_EVENT_TYPES].join(', ')}`,
    )
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new Error(
      `Unsupported webhook schema version: ${schemaVersion}. ` +
      `Supported versions: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}`,
    )
  }

  return repo.create({ organizationId, url, secret, events, schemaVersion })
}

export const removeSubscriber = async (id: string): Promise<boolean> => {
  const removed = await repo.remove(id)
  if (removed) {
    breakerCache.delete(id)
    inFlightProbes.delete(id)
    await repo.removeBreakerState(id).catch(() => {})
  }
  return removed
}

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
 * Dispatches a webhook event to all eligible active subscribers for the
 * given organization with exponential-backoff retry (max 3 attempts).
 * Circuit breaker state is checked per subscriber before delivery;
 * open breakers short-circuit to the dead-letter store.
 * Failures are collected rather than thrown so one bad subscriber cannot
 * block the others.
 */
export const dispatchWebhookEvent = async (
  payload: WebhookDeliveryPayload,
): Promise<WebhookDeliveryResult[]> => {
  const eligible = await repo.findByEvent(payload.organizationId, payload.eventType)
  const config = getCircuitBreakerConfig()

  return Promise.all(
    eligible.map(async (subscriber): Promise<WebhookDeliveryResult> => {
      let attempts = 0
      let lastStatusCode: number | undefined

      // ── Circuit breaker check ──────────────────────────────
      const breaker = await checkBreaker(subscriber.id, config)
      if (!breaker.allowed) {
        await deadLetter(subscriber.id, payload, breaker.shortCircuitReason ?? 'Circuit breaker open', 0)
        return {
          subscriberId: subscriber.id,
          url: subscriber.url,
          success: false,
          error: breaker.shortCircuitReason ?? 'Circuit breaker open',
          attempts: 0,
        }
      }

      // Track in-flight probes for half-open state
      const isHalfOpenProbe = breakerCache.get(subscriber.id)?.state === 'HALF_OPEN'
      if (isHalfOpenProbe) {
        inFlightProbes.add(subscriber.id)
      }

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

        // ── Success — reset breaker ──────────────────────────
        if (isHalfOpenProbe) {
          inFlightProbes.delete(subscriber.id)
        }
        await recordBreakerSuccess(subscriber.id, config)

        return {
          subscriberId: subscriber.id,
          url: subscriber.url,
          statusCode: lastStatusCode,
          success: true,
          attempts,
        }
      } catch (err: any) {
        if (isHalfOpenProbe) {
          inFlightProbes.delete(subscriber.id)
        }

        console.error(`[Webhooks] delivery failed for subscriber ${subscriber.id}:`, err?.message)
        const error = err?.message ?? 'Unknown error'

        // ── Failure — record in breaker ─────────────────────
        await recordBreakerFailure(subscriber.id, config)

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

export const getBreakerStatesForMetrics = async (): Promise<{
  closed: number
  open: number
  halfOpen: number
}> => {
  const states = await repo.getAllBreakerStates()
  let closed = 0
  let open = 0
  let halfOpen = 0
  for (const s of states) {
    if (s.state === 'CLOSED') closed++
    else if (s.state === 'OPEN') open++
    else if (s.state === 'HALF_OPEN') halfOpen++
  }
  return { closed, open, halfOpen }
}

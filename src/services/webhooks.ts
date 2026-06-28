import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { WebhookSubscriberRepository } from '../repositories/webhookSubscriberRepository.js'
import { retryWithBackoff } from '../utils/retry.js'
import { db } from '../db/index.js'
import { applyFieldMasking, FieldPolicy, DEFAULT_FIELD_POLICY, parseFieldPolicy } from '../utils/webhookFieldMasking.js'

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
  /**
   * The previous signing secret retained during the rotation grace window.
   * Null when no rotation has occurred or after the grace window has closed
   * and the column has been cleared.
   */
  previousSecret: string | null
  /**
   * ISO 8601 timestamp of when the most recent secret rotation occurred.
   * Used together with WEBHOOK_SECRET_GRACE_WINDOW_MS to determine whether
   * the previous secret is still valid for verifying inbound signatures.
   */
  rotatedAt: string | null
  events: string[]
  active: boolean
  createdAt: string
  schemaVersion: number
  /**
   * Per-subscriber field masking policy. Controls which fields are included
   * in webhook payloads and whether PII is stripped. Applied before signing.
   */
  fieldPolicy: FieldPolicy
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
 * Field masking is applied BEFORE serialization, so the signature is computed
 * on the masked payload. This ensures subscribers can verify the signature
 * even when fields are filtered or PII is stripped.
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
  // Apply field masking policy to the data before serialization
  const fieldPolicy = subscriber.fieldPolicy ?? DEFAULT_FIELD_POLICY
  const maskedData = applyFieldMasking(payload.data, fieldPolicy)

  switch (subscriber.schemaVersion) {
    case 1:
      return JSON.stringify({
        eventId: payload.eventId,
        eventType: payload.eventType,
        timestamp: payload.timestamp,
        data: maskedData,
        organizationId: payload.organizationId,
        schema_version: 1,
      })
    case 2:
      return JSON.stringify({
        schema_version: 2,
        event_type: payload.eventType,
        data: maskedData,
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

/**
 * Verifies a signature against a subscriber's current secret and, when within
 * the rotation grace window, also against the previous secret.
 *
 * This lets subscribers that have not yet updated their secret still pass
 * verification until the grace window closes.
 *
 * Returns `true` if at least one of the valid secrets matches.
 */
export const verifySignatureWithGrace = (
  subscriber: WebhookSubscriber,
  body: string,
  signature: string,
): boolean => {
  if (verifySignature(subscriber.secret, body, signature)) return true
  if (isPreviousSecretInGrace(subscriber)) {
    return verifySignature(subscriber.previousSecret!, body, signature)
  }
  return false
}

// ── Egress allowlist ──────────────────────────────────────────────────────────

export interface EgressAllowlistEntry {
  id: string
  organizationId: string
  host: string
  createdAt: string
}

/**
 * Returns the per-org egress allowlist hosts for an organization.
 * Empty array means no allowlist is configured (baseline SSRF guard only).
 */
export const getEgressAllowlist = async (organizationId: string): Promise<string[]> => {
  const rows = await db('org_webhook_egress_allowlists')
    .where({ organization_id: organizationId })
    .select('host')
  return rows.map((r: { host: string }) => r.host)
}

/**
 * Adds a host to an org's egress allowlist. Idempotent — duplicate host is ignored.
 */
export const addEgressAllowlistEntry = async (
  organizationId: string,
  host: string,
): Promise<EgressAllowlistEntry> => {
  const [row] = await db('org_webhook_egress_allowlists')
    .insert({ organization_id: organizationId, host: host.toLowerCase() })
    .onConflict(['organization_id', 'host'])
    .merge({ host: host.toLowerCase() })
    .returning('*')
  return {
    id: row.id,
    organizationId: row.organization_id,
    host: row.host,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

/**
 * Removes a host from an org's egress allowlist.
 * Returns true if a row was deleted.
 */
export const removeEgressAllowlistEntry = async (
  organizationId: string,
  host: string,
): Promise<boolean> => {
  const count = await db('org_webhook_egress_allowlists')
    .where({ organization_id: organizationId, host: host.toLowerCase() })
    .del()
  return count > 0
}

/**
 * Lists all egress allowlist entries for an organization.
 */
export const listEgressAllowlist = async (
  organizationId: string,
): Promise<EgressAllowlistEntry[]> => {
  const rows = await db('org_webhook_egress_allowlists')
    .where({ organization_id: organizationId })
    .orderBy('created_at', 'asc')
  return rows.map((row: any) => ({
    id: row.id,
    organizationId: row.organization_id,
    host: row.host,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }))
}

/**
 * Checks whether a URL is permitted for the given organization, respecting:
 * 1. The global SSRF guard (unconditional baseline).
 * 2. The per-org egress allowlist, when configured (deny by policy if not on it).
 *
 * When the org has no allowlist entries the SSRF guard alone governs.
 */
export const isUrlAllowedForOrg = async (
  organizationId: string,
  url: string,
): Promise<{ allowed: boolean; reason?: string }> => {
  if (!isUrlAllowed(url)) {
    return { allowed: false, reason: `Webhook URL not permitted: ${url}` }
  }
  const orgHosts = await getEgressAllowlist(organizationId)
  if (orgHosts.length === 0) {
    return { allowed: true }
  }
  if (!isUrlAllowed(url, orgHosts)) {
    return { allowed: false, reason: `Webhook URL not on egress allowlist for org: ${url}` }
  }
  return { allowed: true }
}

export const addSubscriber = async (
  organizationId: string,
  url: string,
  secret: string,
  events: string[],
  schemaVersion: number = DEFAULT_SCHEMA_VERSION,
): Promise<WebhookSubscriber> => {
  const check = await isUrlAllowedForOrg(organizationId, url)
  if (!check.allowed) {
    throw new Error(check.reason!)
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

/**
 * Idempotent variant of addSubscriber.
 *
 * Re-registering the same (org, URL) pair updates the existing row in-place
 * instead of inserting a duplicate.  Delivery history (dead letters keyed on
 * subscriber_id) is preserved because the row's primary key does not change.
 */
export const upsertSubscriber = async (
  organizationId: string,
  url: string,
  secret: string,
  events: string[],
): Promise<WebhookSubscriber> => {
  const check = await isUrlAllowedForOrg(organizationId, url)
  if (!check.allowed) {
    throw new Error(check.reason!)
  }

  return repo.upsert({ organizationId, url, secret, events })
}

/**
 * Rotates the signing secret for a subscriber.
 *
 * The previous secret is stored alongside the new one for
 * WEBHOOK_SECRET_GRACE_WINDOW_MS milliseconds (default 24 h) so any
 * in-flight deliveries signed with the old key continue to verify.
 *
 * Returns null when the subscriber does not exist or belongs to a different
 * organization.
 */
export const rotateSubscriberSecret = async (
  id: string,
  organizationId: string,
  newSecret: string,
): Promise<WebhookSubscriber | null> => {
  return repo.rotateSecret(id, organizationId, newSecret)
}

/**
 * Default grace window: 24 hours. Override via WEBHOOK_SECRET_GRACE_WINDOW_MS.
 */
const DEFAULT_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000

export const getGraceWindowMs = (): number => {
  const raw = process.env.WEBHOOK_SECRET_GRACE_WINDOW_MS
  if (raw) {
    const parsed = parseInt(raw, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_GRACE_WINDOW_MS
}

/**
 * Returns true if the previous secret for a subscriber is still within its
 * rotation grace window (i.e. it should still be accepted for verification).
 */
export const isPreviousSecretInGrace = (subscriber: WebhookSubscriber): boolean => {
  if (!subscriber.previousSecret || !subscriber.rotatedAt) return false
  const rotatedAt = new Date(subscriber.rotatedAt).getTime()
  return Date.now() - rotatedAt < getGraceWindowMs()
}

export const listSubscribers = async (organizationId: string): Promise<WebhookSubscriber[]> =>
  repo.findByOrg(organizationId)

/**
 * Updates the field masking policy for a subscriber.
 * Returns null when the subscriber does not exist or belongs to a different org.
 */
export const updateSubscriberFieldPolicy = async (
  id: string,
  organizationId: string,
  fieldPolicy: FieldPolicy,
): Promise<WebhookSubscriber | null> => {
  return repo.updateFieldPolicy(id, organizationId, fieldPolicy)
}

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

  // Load org allowlist once for the whole dispatch batch (defense in depth)
  const orgAllowlistHosts = await getEgressAllowlist(payload.organizationId)

  return Promise.all(
    eligible.map(async (subscriber): Promise<WebhookDeliveryResult> => {
      let attempts = 0
      let lastStatusCode: number | undefined

      // ── Egress allowlist check (delivery-time enforcement) ─────────────────
      if (!isUrlAllowed(subscriber.url)) {
        const reason = `Webhook URL not permitted: ${subscriber.url}`
        await deadLetter(subscriber.id, payload, reason, 0)
        return { subscriberId: subscriber.id, url: subscriber.url, success: false, error: reason, attempts: 0 }
      }
      if (orgAllowlistHosts.length > 0 && !isUrlAllowed(subscriber.url, orgAllowlistHosts)) {
        const reason = `Webhook URL not on egress allowlist for org: ${subscriber.url}`
        await deadLetter(subscriber.id, payload, reason, 0)
        return { subscriberId: subscriber.id, url: subscriber.url, success: false, error: reason, attempts: 0 }
      }

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

  const check = await isUrlAllowedForOrg(subscriber.organizationId, subscriber.url)
  if (!check.allowed) {
    return { replayed: false, error: check.reason! }
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

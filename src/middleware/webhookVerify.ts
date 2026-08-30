/* global global */

import { Request, Response, NextFunction } from 'express'
import * as crypto from 'crypto'
import { getEnv } from '../config/index.js'
import { AppError } from './errorHandler.js'
import { getTracer } from '../observability/tracing.js'
import { logger } from './logger.js'

interface CustomWebhookRequest extends Request {
  rawBody?: string
}

// ---------------------------------------------------------------------------
// Inbound payload boundary
//
// Beyond signature/replay/timestamp verification this middleware enforces a
// shape invariant (payload must be a JSON object — never a bare value or
// array) and, when the deployment pins a network, that an inbound delivery
// carrying a `network`/`network_passphrase`/`networkPassphrase` field agrees
// with the configured Stellar network. This rejects wrong-network events at
// the boundary instead of letting them regress local vault state.
// ---------------------------------------------------------------------------

/**
 * The Stellar network this deployment expects inbound webhook deliveries to
 * originate from. Resolved from `WEBHOOK_EXPECTED_NETWORK` if set, otherwise
 * from `SOROBAN_NETWORK_PASSPHRASE`. `undefined` means "accept any network"
 * (the invariant is skipped), preserving forward compatibility for
 * deployments that have not pinned a network.
 */
export const getExpectedInboundNetwork = (): string | undefined =>
  process.env.WEBHOOK_EXPECTED_NETWORK ??
  process.env.SOROBAN_NETWORK_PASSPHRASE ??
  undefined

export interface WebhookBodyValidation {
  ok: boolean
  error?: string
}

/**
 * Validates the parsed inbound webhook body at the boundary.
 *
 * 1. The body must be a non-null plain object. JSON arrays and primitives are
 *    rejected so downstream handlers never have to defend against a payload
 *    with no object shape.
 * 2. If a network is declared on the payload AND `expectedNetwork` is set,
 *    they must match exactly (trimmed, non-empty). A payload that omits the
 *    network field is still accepted to support legacy signing clients.
 */
export const validateWebhookBody = (
  body: unknown,
  expectedNetwork?: string,
): WebhookBodyValidation => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Webhook payload must be a JSON object' }
  }

  if (expectedNetwork) {
    const payload = body as Record<string, unknown>
    const network = payload.network ?? payload.network_passphrase ?? payload.networkPassphrase
    if (typeof network === 'string' && network.trim() !== '' && network.trim() !== expectedNetwork.trim()) {
      return { ok: false, error: 'Webhook event not from the expected network' }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Nonce stores are defined below as BoundedReplayStore instances
// (`confirmedNonces` for successfully verified deliveries, `pendingNonces`
// for in-flight reservations). Reservation is synchronous, so concurrent
// duplicates are blocked before the body read / HMAC work.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bounded replay-protection store
//
// Deduplication records: `${timestamp}:${nonce}` tuples that are either
// currently in-flight (pendingNonces, reserved before the body is read so a
// concurrent duplicate is blocked synchronously) or already verified
// (confirmedNonces).
//
// The store is memory-bounded in two ways:
//   1. A strict `maxSize` cap – when a new key would exceed it, the oldest
//      inserted entry is evicted. This guarantees memory stays O(cap) even
//      under high churn while the periodic sweep lags or never runs.
//   2. Lazy + periodic TTL eviction – entries whose header timestamp falls
//      outside the configured skew window are expired on access and swept by
//      a background interval, so stale tuples don't linger and keep a large
//      cache from holding onto dead data.
//
// Node runs JS on a single thread, so `add` (reservation) is atomic w.r.t.
// other in-flight requests; the async body-read/HMAC work that follows is
// where the old TOCTOU replay window lived, which is why reservation happens
// before the first `await`.
// ---------------------------------------------------------------------------
export class BoundedReplayStore {
  /** Map preserves insertion order — the first key is the oldest inserted. */
  private readonly entries = new Map<string, number>()
  /** Maximum number of retained entries (strict memory bound). */
  maxSize: number
  /** Skew window (ms) after which an entry is considered stale. */
  skewMs: number

  constructor(maxSize: number, skewMs: number) {
    this.maxSize = maxSize
    this.skewMs = skewMs
  }

  /** True when the key is present and not yet expired. */
  has(key: string): boolean {
    const ts = this.entries.get(key)
    if (ts === undefined) return false
    if (Math.abs(Date.now() - ts) > this.skewMs) {
      // Lazy TTL eviction – reclaims memory without waiting for the sweep.
      this.entries.delete(key)
      return false
    }
    return true
  }

  /**
   * Insert a key, remembering the epoch milliseconds it should be kept until.
   * Enforces the memory bound by evicting the oldest-inserted entry once the
   * capacity is exceeded. Returns the stored timestamp.
   */
  add(key: string, timestampMs: number): number {
    this.entries.set(key, timestampMs)
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return timestampMs
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  /** Expire all entries whose stored timestamp is outside the skew window. */
  sweep(): void {
    const now = Date.now()
    for (const [key, ts] of this.entries) {
      if (Math.abs(now - ts) > this.skewMs) {
        this.entries.delete(key)
      }
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

const DEFAULT_REPLAY_CACHE_SIZE = 10_000

/** Replay-protection cache, sized by env (default 10k tuples). */
export const confirmedNonces = new BoundedReplayStore(
  DEFAULT_REPLAY_CACHE_SIZE,
  0, // skew is wired from the environment on first use
)

/** In-flight reservations (TOCTOU guard). */
export const pendingNonces = new BoundedReplayStore(
  DEFAULT_REPLAY_CACHE_SIZE,
  0, // skew is wired from the environment on first use
)

// Sweep expired nonce records from both stores, plus enforce the max-size cap,
// to keep replay-protection memory bounded.
global.setInterval(() => {
  try {
    const skewMs = getEnv().WEBHOOK_INBOUND_SKEW_MS
    confirmedNonces.skewMs = skewMs
    pendingNonces.skewMs = skewMs
  } catch {
    // env not initialised yet — leave skew as-is; sweep with current values.
  }
  confirmedNonces.sweep()
  pendingNonces.sweep()
}, 60_000).unref()

// ── Prometheus telemetry (lazily registered, never blocks, never leaks) ─────
let verifyCounter: { inc: (labels: { outcome: string }) => void } | null = null
let verifyDurationHistogram: { observe: (value: number) => void } | null = null
let webhookMetricsReady = false
let metricsPromise: Promise<void> | null = null

async function ensureWebhookMetrics(): Promise<void> {
  if (webhookMetricsReady) return
  if (metricsPromise) return metricsPromise
  metricsPromise = (async () => {
    try {
      const client = await import('prom-client')
      const { register: metricsRegistry } = await import('../observability/metricsRegistry.js')
      verifyCounter = new client.Counter({
        name: 'disciplr_webhook_inbound_verify_total',
        help: 'Inbound webhook signature-verification results by outcome',
        labelNames: ['outcome'],
        registers: [metricsRegistry],
      })
      verifyDurationHistogram = new client.Histogram({
        name: 'disciplr_webhook_inbound_verify_duration_ms',
        help: 'Inbound webhook verification latency in milliseconds',
        buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
        registers: [metricsRegistry],
      })
    } catch {
      // Metrics unavailable (e.g. unit tests without a registry) — no-op.
      verifyCounter = { inc: () => {} }
      verifyDurationHistogram = { observe: () => {} }
    } finally {
      webhookMetricsReady = true
    }
  })()
  return metricsPromise
}

function emitTelemetry(outcome: WebhookVerifyOutcome, durationMs: number): void {
  // Fire-and-forget; never throws and never surfaces secret material.
  void ensureWebhookMetrics()
  verifyCounter?.inc({ outcome })
  verifyDurationHistogram?.observe(durationMs)
}

/**
 * Verify an inbound webhook request cryptographically before it reaches any
 * handler:
 *   - Enforces the x-webhook-signature / x-webhook-timestamp / x-webhook-nonce
 *     header contract.
 *   - Bounds the payload size (413) before JSON parsing / HMAC work.
 *   - Rejects timestamps outside the configured skew window (replay window).
 *   - Deduplicates (timestamp, nonce) with a bounded store and a synchronous
 *     reservation that blocks concurrent replays (TOCTOU).
 *   - Emits structured telemetry (latency + outcome) without logging the
 *     secret, signature, nonce, or body.
 */
export const webhookVerify = async (
  req: CustomWebhookRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const startedAt = Date.now()
  const tracer = getTracer()

    const secret = getEnv().WEBHOOK_SECRET
    const skewMs = getEnv().WEBHOOK_INBOUND_SKEW_MS
    if (!secret) {
      res.status(500).json({ error: 'Webhook verification secret is not configured' })
      return
    }

    const signature = req.headers['x-webhook-signature'] as string
    const timestampHeader = req.headers['x-webhook-timestamp'] as string
    const nonce = req.headers['x-webhook-nonce'] as string

    if (!signature || !timestampHeader || !nonce) {
      res.status(401).json({ error: 'Missing required webhook headers' })
      return
    }

    const timestamp = parseInt(timestampHeader, 10)
    if (isNaN(timestamp)) {
      res.status(401).json({ error: 'Invalid timestamp header' })
      return
    }

    const now = Date.now()
    if (Math.abs(now - timestamp) > skewMs) {
      res.status(401).json({ error: 'Webhook request outside of allowed time window' })
      return
    }

    const cacheKey = `${timestamp}:${nonce}`

    // Keep the replay-protection stores aligned with the configured skew so
    // duplicate detection works before the background sweep first runs.
    confirmedNonces.skewMs = skewMs
    pendingNonces.skewMs = skewMs

    // -----------------------------------------------------------------------
    // Replay-protection check + reservation (synchronous, single event-loop
    // turn).  Both checks happen before any await so concurrent requests with
    // the same nonce are blocked here — not after the expensive body read.
    // -----------------------------------------------------------------------
    if (confirmedNonces.has(cacheKey) || pendingNonces.has(cacheKey)) {
      res.status(401).json({ error: 'Replayed webhook request' })
      return
    }

    // Reserve the nonce slot.  If verification fails we remove it so a
    // legitimate retry with a new nonce is unaffected (the cacheKey includes
    // the nonce, so a retry with a different nonce is a different key).
    pendingNonces.add(cacheKey, timestamp)

    // Read the raw body
    let rawBody: string
    try {
      rawBody = await new Promise<string>((resolve, reject) => {
        let body = ''
        let limitExceeded = false
        req.on('data', (chunk) => {
          if (limitExceeded) return
          body += chunk.toString()
          if (body.length > 500_000) {
            limitExceeded = true
            next(AppError.payloadTooLarge('Payload exceeds 500KB safety limit'))
            reject(new Error('Payload too large'))
          }
        })
        req.on('end', () => resolve(body))
        req.on('error', reject)
      })
    } catch {
      pendingNonces.delete(cacheKey)
      return
    }

    // Store raw body on req for downstream use
    req.rawBody = rawBody

    // Parse JSON — reject explicitly on malformed input rather than silently
    // substituting {} which would mask bad payloads from downstream handlers.
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(rawBody)
    } catch {
      pendingNonces.delete(cacheKey)
      res.status(400).json({ error: 'Invalid JSON body' })
      return
    }

    // Enforce the payload shape + network invariants at the boundary. A
    // malformed body never consumes the nonce, so a corrected retry with the
    // same nonce is still permitted (mirrors invalid-JSON behavior).
    const bodyValidation = validateWebhookBody(parsedBody, getExpectedInboundNetwork())
    if (!bodyValidation.ok) {
      pendingNonces.delete(cacheKey)
      res.status(400).json({ error: bodyValidation.error })
      return
    }
    req.body = parsedBody

    // Verify HMAC
    const expectedDigest = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${nonce}.${rawBody}`)
      .digest('hex')

    const expectedSignature = `sha256=${expectedDigest}`

    if (
      signature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(global.Buffer.from(signature), global.Buffer.from(expectedSignature))
    ) {
      pendingNonces.delete(cacheKey)
      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }

    // Verification passed — promote from pending to confirmed.
    pendingNonces.delete(cacheKey)
    nonceCache.add(cacheKey)
    next()
  } catch (err: unknown) {
    next(err)
  }

  // Wrap the verification in a named span for tracing. Attributes are strictly
  // cardinality-safe and never contain the secret or signature.
  return tracer.withSpan('webhook.inbound_verify', async (span) => {
    span.setAttribute('webhook.inbound', true)

    // Track a reserved nonce so an unexpected mid-flight error can still
    // release the reservation instead of leaking it until the TTL sweep.
    let reservedKey: string | undefined

    try {
      // Ensure telemetry exists before the first request records against it.
      // Guarded internally and resolves quickly after the first call.
      await ensureWebhookMetrics()

      const env = getEnv()
      const secret = env.WEBHOOK_INBOUND_SECRET
      const skewMs = env.WEBHOOK_INBOUND_SKEW_MS
      const maxBodyBytes = env.WEBHOOK_INBOUND_MAX_BODY_BYTES
      const replayCacheSize = env.WEBHOOK_REPLAY_CACHE_SIZE

      // Keep store capacities in sync with the environment (idempotent).
      confirmedNonces.maxSize = replayCacheSize
      confirmedNonces.skewMs = skewMs
      pendingNonces.maxSize = replayCacheSize
      pendingNonces.skewMs = skewMs

      if (!secret) {
        record('no_secret', 500)
        res.status(500).json({ error: 'Webhook verification secret is not configured' })
        return
      }

      const signature = req.headers['x-webhook-signature'] as string
      const timestampHeader = req.headers['x-webhook-timestamp'] as string
      const nonce = req.headers['x-webhook-nonce'] as string

      if (!signature || !timestampHeader || !nonce) {
        record('missing_headers', 401)
        res.status(401).json({ error: 'Missing required webhook headers' })
        return
      }

      const timestamp = parseInt(timestampHeader, 10)
      if (isNaN(timestamp)) {
        record('invalid_timestamp', 401)
        res.status(401).json({ error: 'Invalid timestamp header' })
        return
      }

      const now = Date.now()
      if (Math.abs(now - timestamp) > skewMs) {
        record('outside_window', 401)
        res.status(401).json({ error: 'Webhook request outside of allowed time window' })
        return
      }

      const cacheKey = `${timestamp}:${nonce}`

      // Replay-protection check + reservation, synchronous and atomic w.r.t.
      // other in-flight requests. Blocks concurrent replays before the body
      // is read and before any await.
      if (confirmedNonces.has(cacheKey) || pendingNonces.has(cacheKey)) {
        record('replay', 401)
        res.status(401).json({ error: 'Replayed webhook request' })
        return
      }
      pendingNonces.add(cacheKey, timestamp)
      reservedKey = cacheKey

      // Read the raw body with a strict byte budget. Exceeding the budget
      // rejects with 413 before any JSON parsing or HMAC work.
      let rawBody: string
      try {
        rawBody = await readBody(req, maxBodyBytes)
      } catch (err) {
        pendingNonces.delete(cacheKey)
        reservedKey = undefined
        if (err instanceof AppError && err.status === 413) {
          record('payload_too_large', 413)
          res.status(413).json({ error: err.message })
          return
        }
        record('body_read_error', 500)
        next(err)
        return
      }

      req.rawBody = rawBody

      // Parse JSON — reject explicitly on malformed input rather than silently
      // substituting {} which would mask bad payloads from downstream handlers.
      try {
        req.body = JSON.parse(rawBody)
      } catch {
        pendingNonces.delete(cacheKey)
        reservedKey = undefined
        record('invalid_json', 400)
        res.status(400).json({ error: 'Invalid JSON body' })
        return
      }

      // Verify HMAC in constant time.
      const expectedDigest = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${nonce}.${rawBody}`)
        .digest('hex')
      const expectedSignature = `sha256=${expectedDigest}`

      if (
        signature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(global.Buffer.from(signature), global.Buffer.from(expectedSignature))
      ) {
        pendingNonces.delete(cacheKey)
        reservedKey = undefined
        record('bad_signature', 401)
        res.status(401).json({ error: 'Invalid webhook signature' })
        return
      }

      // Verification passed — promote from pending to confirmed.
      pendingNonces.delete(cacheKey)
      confirmedNonces.add(cacheKey, timestamp)
      reservedKey = undefined
      emitTelemetry('success', Date.now() - startedAt)
      span.setStatus({ code: 'OK' })
      next()
    } catch (err) {
      if (reservedKey) pendingNonces.delete(reservedKey)
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      span.setStatus({ code: 'ERROR', message: 'Webhook verification failed' })
      next(err)
    }
  })
}

/**
 * Accumulates the raw request body up to `maxBytes`. Rejects with a 413
 * {@link AppError} as soon as the budget is exceeded so oversized payloads
 * are dropped before further processing (and before the HMAC is computed).
 */
function readBody(req: Request, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = ''
    let done = false

    const rejectOnce = (err: unknown) => {
      if (done) return
      done = true
      reject(err)
    }
    const resolveOnce = (value: string) => {
      if (done) return
      done = true
      resolve(value)
    }

    req.on('data', (chunk) => {
      if (done) return
      const chunkStr = chunk.toString()
      if (body.length + chunkStr.length > maxBytes) {
        rejectOnce(AppError.payloadTooLarge('Payload exceeds safety limit'))
        return
      }
      body += chunkStr
    })
    req.on('end', () => resolveOnce(body))
    req.on('error', rejectOnce)
  })
}
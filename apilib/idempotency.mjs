// Idempotency-Key support for the deployed API's write routes.
//
// An optional `Idempotency-Key` header turns a retry (network timeout,
// double-click, client replay) into a replay of the original response instead
// of a duplicate side effect. Reservations are persisted by the store
// (Postgres `idempotency_reservations` or an in-process Map) and are scoped per
// route so one client key can never replay a response across routes.
//
// TODO(auth): bind reservations to the authenticated principal (user + org) so
// one caller cannot replay another caller's key. Out of scope for this change.
import { createHash } from 'node:crypto'

// 8-255 chars of [A-Za-z0-9_-]; anything else is rejected before any work runs.
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,255}$/

// Stored response bodies are capped so a reservation cannot be used to park an
// oversized payload. Oversized responses release the reservation instead of
// being stored, so the request simply retries without replay.
export const MAX_STORED_BODY = 64 * 1024

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/** Reservation TTL: 24h unless overridden with IDEMPOTENCY_TTL_MS (ms). */
export function idempotencyTtlMs(env = process.env) {
  const configured = Number(env.IDEMPOTENCY_TTL_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS
}

/**
 * Deterministic JSON: object keys are sorted recursively so the hash of a
 * request body does not depend on the order the client serialised it.
 * Undefined values are dropped (matching JSON.stringify); array holes and
 * undefined entries become null.
 */
export function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  const parts = []
  for (const key of keys) {
    const entry = value[key]
    if (entry === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`)
  }
  return `{${parts.join(',')}}`
}

/** sha256(method + path + canonical JSON body), hex encoded. */
export function requestHash(method, path, body) {
  return createHash('sha256')
    .update(`${method} ${path} ${canonicalJson(body)}`)
    .digest('hex')
}

async function releaseQuietly(store, { scope, key }, req) {
  try {
    await store.releaseIdempotency({ scope, key })
  } catch (err) {
    // Best effort: an un-released reservation still expires with its TTL.
    req?.log?.warn({ err, scope }, 'Failed to release idempotency reservation')
  }
}

async function completeQuietly(store, { scope, key }, captured, req) {
  try {
    await store.completeIdempotency({ scope, key, status: captured.status, body: captured.body })
  } catch (err) {
    // The side effect already happened; the response is still delivered and the
    // reservation expires on its own rather than failing a successful request.
    req?.log?.warn({ err, scope }, 'Failed to complete idempotency reservation')
  }
}

/**
 * Wraps a write-route handler with Idempotency-Key semantics.
 *
 * - no header            -> handler runs untouched (behaviour unchanged)
 * - invalid key          -> 400
 * - key completed        -> stored status + body replayed with
 *                           `Idempotent-Replayed: true` (byte-identical)
 * - key pending          -> 409 { error: 'Request in progress' }
 * - key, different hash  -> 422
 * - handler success 2xx/4xx -> response stored, then sent
 * - handler throws       -> reservation released, error propagates (5xx path)
 *
 * The response is buffered so the reservation is durable *before* the client
 * sees the response; otherwise a fast retry could land between "response
 * flushed" and "reservation completed" and get a spurious 409.
 *
 * @param {string} scope route-level reservation scope (e.g. 'vault.create')
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} handler
 * @param {{ getStore: () => Promise<any> }} deps
 */
export function withIdempotency(scope, handler, { getStore }) {
  if (typeof getStore !== 'function') throw new Error('withIdempotency requires a getStore function')
  if (typeof handler !== 'function') throw new Error('withIdempotency requires a handler function')

  return async function idempotentRoute(req, res) {
    const raw = req.headers['idempotency-key']
    // Header omitted: behave exactly as if this wrapper did not exist.
    if (raw === undefined) return handler(req, res)

    const key = Array.isArray(raw) ? raw[0] : raw
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      return res.status(400).json({
        error: 'Invalid Idempotency-Key: expected 8-255 characters of A-Z, a-z, 0-9, "-" or "_"',
      })
    }

    const store = await getStore()
    // Stores without reservation support (custom test doubles) fall back to
    // plain handler behaviour rather than failing the request.
    if (typeof store?.reserveIdempotency !== 'function') return handler(req, res)

    // Path (not query) is part of the fingerprint; scopes additionally separate
    // routes, so a key reused on another route claims its own reservation.
    const fingerprint = requestHash(req.method, req.path, req.body)
    const reserved = await store.reserveIdempotency({ scope, key, requestHash: fingerprint, now: new Date() })

    if (reserved.outcome === 'conflict') {
      return res.status(422).json({ error: 'Idempotency-Key was used with a different request' })
    }
    if (reserved.outcome === 'in_progress') {
      return res.status(409).json({ error: 'Request in progress' })
    }
    if (reserved.outcome === 'replayed') {
      res.status(reserved.status)
      if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Idempotent-Replayed', 'true')
      res.setHeader('Content-Length', Buffer.byteLength(reserved.body, 'utf8'))
      res.end(reserved.body)
      return undefined
    }
    if (reserved.outcome !== 'claimed') {
      throw new Error(`Unexpected idempotency reserve outcome: ${reserved?.outcome}`)
    }

    // Buffer JSON responses so completion happens before the client is told.
    const sendJson = res.json.bind(res)
    let captured = null
    res.json = (payload) => {
      if (!captured) captured = { status: res.statusCode || 200, body: JSON.stringify(payload) }
      return res
    }

    try {
      await handler(req, res)
    } catch (err) {
      res.json = sendJson
      await releaseQuietly(store, { scope, key }, req)
      throw err
    }
    res.json = sendJson

    if (!captured) {
      await releaseQuietly(store, { scope, key }, req)
      if (res.headersSent) return undefined
      throw new Error('Idempotent handler finished without producing a JSON response')
    }

    const oversized = Buffer.byteLength(captured.body, 'utf8') > MAX_STORED_BODY
    if (captured.status >= 500 || oversized) {
      // 5xx must not pin the key: the client retries and the work re-runs.
      await releaseQuietly(store, { scope, key }, req)
    } else {
      await completeQuietly(store, { scope, key }, captured, req)
    }

    res.status(captured.status)
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (!res.hasHeader('Content-Length')) {
      res.setHeader('Content-Length', Buffer.byteLength(captured.body, 'utf8'))
    }
    res.end(captured.body)
    return undefined
  }
}

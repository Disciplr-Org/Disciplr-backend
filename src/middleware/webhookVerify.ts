/* global global */


import { Request, Response, NextFunction } from 'express'
import * as crypto from 'crypto'
import { getEnv } from '../config/index.js'
import { AppError } from './errorHandler.js'

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
// Nonce stores
//
// nonceCache:    nonces that have been *successfully* verified. These are the
//                canonical replay-protection records.
//
// pendingNonces: nonces that are currently in-flight (past the synchronous
//                reservation point but not yet verified). This closes the
//                TOCTOU race: if two identical requests arrive concurrently,
//                the second one hits the pendingNonces guard before the first
//                has finished reading its body and checking the HMAC.
//
// Node.js runs JavaScript on a single thread, so the reservation
//   pendingNonces.add(cacheKey)
// is atomic with respect to other in-flight requests – no actual mutex is
// needed. The async body-read/HMAC work that follows happens across multiple
// event-loop turns, which is exactly when the race used to be exploitable.
// ---------------------------------------------------------------------------
const nonceCache = new Set<string>()
const pendingNonces = new Set<string>()

// Sweep expired nonces from both sets to prevent unbounded memory growth.
global.setInterval(() => {
  const now = Date.now()
  const skewMs = getEnv().WEBHOOK_INBOUND_SKEW_MS

  ;[nonceCache, pendingNonces].forEach((store) => {
    store.forEach((entry) => {
      const [timestampStr] = entry.split(':')
      const timestamp = parseInt(timestampStr, 10)
      if (Math.abs(now - timestamp) > skewMs) {
        store.delete(entry)
      }
    })
  })
}, 60_000).unref()

export const webhookVerify = async (
  req: CustomWebhookRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const env = getEnv()
    const secret = env.WEBHOOK_INBOUND_SECRET
    const skewMs = env.WEBHOOK_INBOUND_SKEW_MS

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

    // -----------------------------------------------------------------------
    // Replay-protection check + reservation (synchronous, single event-loop
    // turn).  Both checks happen before any await so concurrent requests with
    // the same nonce are blocked here — not after the expensive body read.
    // -----------------------------------------------------------------------
    if (nonceCache.has(cacheKey) || pendingNonces.has(cacheKey)) {
      res.status(401).json({ error: 'Replayed webhook request' })
      return
    }

    // Reserve the nonce slot.  If verification fails we remove it so a
    // legitimate retry with a new nonce is unaffected (the cacheKey includes
    // the nonce, so a retry with a different nonce is a different key).
    pendingNonces.add(cacheKey)

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
}

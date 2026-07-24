import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { getEnv } from '../config/index.js'

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
setInterval(() => {
  const now = Date.now()
  const skewMs = getEnv().WEBHOOK_INBOUND_SKEW_MS

  for (const store of [nonceCache, pendingNonces]) {
    for (const entry of store) {
      const [timestampStr] = entry.split(':')
      const timestamp = parseInt(timestampStr, 10)
      if (Math.abs(now - timestamp) > skewMs) {
        store.delete(entry)
      }
    }
  }
}, 60_000).unref()

export const webhookVerify = async (
  req: Request,
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
        req.on('data', (chunk) => {
          body += chunk.toString()
          if (body.length > 500_000) {
            req.destroy()
            reject(new Error('Payload too large'))
          }
        })
        req.on('end', () => resolve(body))
        req.on('error', reject)
      })
    } catch (err) {
      pendingNonces.delete(cacheKey)
      throw err
    }

    // Store raw body on req for downstream use
    ;(req as any).rawBody = rawBody

    // Parse JSON — reject explicitly on malformed input rather than silently
    // substituting {} which would mask bad payloads from downstream handlers.
    try {
      req.body = JSON.parse(rawBody)
    } catch {
      pendingNonces.delete(cacheKey)
      res.status(400).json({ error: 'Invalid JSON body' })
      return
    }

    // Verify HMAC
    const expectedDigest = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${nonce}.${rawBody}`)
      .digest('hex')

    const expectedSignature = `sha256=${expectedDigest}`

    if (
      signature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
    ) {
      pendingNonces.delete(cacheKey)
      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }

    // Verification passed — promote from pending to confirmed.
    pendingNonces.delete(cacheKey)
    nonceCache.add(cacheKey)
    next()
  } catch (err) {
    next(err)
  }
}

import { Router, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { webhookVerify } from '../middleware/webhookVerify.js'
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js'
import { createRateLimiter } from '../middleware/rateLimiter.js'
import {
  isUrlAllowed,
  signPayload,
  buildVersionedPayload,
  WebhookDeliveryPayload,
} from '../services/webhooks.js'
import { WebhookSubscriberRepository } from '../repositories/webhookSubscriberRepository.js'
import { db } from '../db/index.js'

export const webhooksRouter = Router()

// ── Rate limiter for the test-ping endpoint ───────────────────────────────────
// Scoped per user+subscriber to prevent abuse as an SSRF probe.
// 5 pings per subscriber per 60 seconds.
const testPingRateLimiter = createRateLimiter({
  windowMs: 60 * 1_000,
  max: 5,
  prefix: 'webhook-test-ping:',
  keyGenerator: (req: Request) => {
    const userId = (req as AuthenticatedRequest).user?.userId ?? req.ip ?? 'unknown'
    const subscriberId = req.params.id ?? 'unknown'
    return `${userId}:${subscriberId}`
  },
})

const repo = new WebhookSubscriberRepository(db)

// ── POST /api/webhooks/:id/test ───────────────────────────────────────────────
/**
 * Sends a signed synthetic `webhook.test` event to the subscriber's delivery
 * URL so the integrator can confirm reachability and HMAC verification before
 * real vault events start flowing.
 *
 * Authorization: caller must be authenticated and the subscriber must belong
 * to the same org that is present on the caller's JWT (`enterpriseId` or
 * userId-scoped org). Cross-org test pings are rejected with 403.
 *
 * Rate-limited: 5 pings per subscriber per minute.
 *
 * Response 200:
 *   { delivered: true, statusCode, latencyMs, signatureHeader }
 *
 * Response 4xx/5xx (delivery failed or blocked):
 *   { delivered: false, error, latencyMs?, signatureHeader? }
 */
webhooksRouter.post(
  '/:id/test',
  authenticate,
  testPingRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest
    const { id } = req.params

    // 1. Load subscriber
    const subscriber = await repo.findById(id)
    if (!subscriber) {
      res.status(404).json({ error: 'Subscriber not found' })
      return
    }

    // 2. Org-scope check: the subscriber must belong to the caller's org.
    //    We derive the caller's org from enterpriseId (enterprise JWT) or
    //    fall back to the orgId query/param set by upstream middleware.
    const callerOrgId =
      authReq.user?.enterpriseId ??
      (authReq as any).orgId ??
      req.query.orgId as string | undefined

    if (!callerOrgId || subscriber.organizationId !== callerOrgId) {
      res.status(403).json({ error: 'Forbidden: subscriber does not belong to your organization' })
      return
    }

    // 3. SSRF guard — reuse the same check used by real delivery
    if (!isUrlAllowed(subscriber.url)) {
      res.status(422).json({ error: 'Subscriber URL is not permitted (SSRF guard)' })
      return
    }

    // 4. Build a synthetic test payload using the same versioned envelope as
    //    real deliveries so the signature covers the exact same byte sequence
    //    that production events will use.
    const syntheticPayload: WebhookDeliveryPayload = {
      eventId: `test:${randomUUID()}`,
      eventType: 'webhook.test',
      timestamp: new Date().toISOString(),
      organizationId: subscriber.organizationId,
      data: {
        message: 'This is a test delivery from Disciplr. If you receive this your endpoint is reachable and your HMAC verification is correctly wired.',
      },
    }

    const body = buildVersionedPayload(subscriber, syntheticPayload)
    const signatureHeader = signPayload(subscriber.secret, body)

    // 5. Deliver — manual fetch so we can capture latency and status without
    //    the retry loop used by dispatchWebhookEvent (test pings are one-shot).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const startMs = Date.now()

    try {
      const response = await fetch(subscriber.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-disciplr-signature': signatureHeader,
          'x-disciplr-event': 'webhook.test',
          'x-disciplr-event-id': syntheticPayload.eventId,
          'x-disciplr-delivery-timestamp': syntheticPayload.timestamp,
        },
        body,
        signal: controller.signal,
      })

      const latencyMs = Date.now() - startMs
      clearTimeout(timer)

      // Refuse redirects just like real deliveries do
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? ''
        res.status(200).json({
          delivered: false,
          error: `Redirect refused${location ? `: ${location}` : ''}`,
          latencyMs,
          signatureHeader,
        })
        return
      }

      const delivered = response.status < 400
      res.status(200).json({
        delivered,
        statusCode: response.status,
        latencyMs,
        // Return the signature header so integrators can confirm it matches
        // what their verification code expects. The secret itself is never
        // included in any response.
        signatureHeader,
        ...(delivered ? {} : { error: `HTTP ${response.status}` }),
      })
    } catch (err: any) {
      clearTimeout(timer)
      const latencyMs = Date.now() - startMs
      const isTimeout = err?.name === 'AbortError'
      res.status(200).json({
        delivered: false,
        error: isTimeout ? 'Request timed out after 10 s' : (err?.message ?? 'Delivery failed'),
        latencyMs,
        signatureHeader,
      })
    }
  },
)

// ── Inbound provider callback ─────────────────────────────────────────────────
// Mount the inbound webhook verification middleware only for provider callbacks,
// not for the outbound test-ping route above.
webhooksRouter.post('/provider-callback', webhookVerify, (req, res) => {
  // At this point, the request has been verified (HMAC, timestamp, nonce)
  // Process the webhook payload (available in req.body)

  res.status(200).json({ received: true })
})

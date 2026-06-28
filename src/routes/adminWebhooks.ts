import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import { UserRole } from '../types/user.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { db } from '../db/knex.js'
import {
  replayDeadLetter,
  upsertSubscriber,
  rotateSubscriberSecret,
  listSubscribers,
  addEgressAllowlistEntry,
  removeEgressAllowlistEntry,
  listEgressAllowlist,
  updateSubscriberFieldPolicy,
} from '../services/webhooks.js'
import { isPaused, pauseDelivery, resumeDelivery } from '../services/pauseStore.js'
import { isValidFieldPolicy, FieldPolicy } from '../utils/webhookFieldMasking.js'

export const adminWebhooksRouter = Router()

adminWebhooksRouter.use(authenticate)
adminWebhooksRouter.use(requireAdmin)

adminWebhooksRouter.get('/dead-letters', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50
    const offset = req.query.offset ? Number(req.query.offset) : 0

    const query = db('webhook_dead_letters').orderBy('failed_at', 'desc')

    if (req.query.subscriber_id) {
      query.where('subscriber_id', req.query.subscriber_id)
    }

    const [{ total }] = await query.clone().count('* as total')
    const entries = await query.limit(limit).offset(offset)

    res.status(200).json({
      webhook_dead_letters: entries,
      count: entries.length,
      total: Number(total),
      limit,
      offset,
      has_more: offset + entries.length < Number(total),
    })
  } catch (error) {
    console.error('Error fetching webhook dead letters:', error)
    res.status(500).json({ error: 'Failed to fetch dead letters' })
  }
})

adminWebhooksRouter.post('/dead-letters/:id/replay', async (req: Request, res: Response) => {
  try {
    const result = await replayDeadLetter(req.params.id)

    if (!result.replayed) {
      res.status(404).json({ error: result.error })
      return
    }

    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'webhook.deadletter.replay',
      target_type: 'webhook_dead_letter',
      target_id: req.params.id,
      metadata: {
        subscriberId: result.subscriberId,
      },
    })

    res.status(202).json({ replayed: true })
  } catch (error) {
    console.error('Error replaying webhook dead letter:', error)
    res.status(500).json({ error: 'Failed to replay dead letter' })
  }
})

/**
 * POST /api/admin/webhooks/subscribers
 *
 * Idempotent upsert: registers a new subscriber or updates the existing one
 * for the same (organization_id, url) pair without creating duplicates.
 * Delivery history is preserved across re-registrations.
 *
 * Body: { organization_id, url, secret, events? }
 * Response 200: { id, organization_id, url, events, active, created_at }
 *   (secret is never returned)
 */
adminWebhooksRouter.post('/subscribers', async (req: Request, res: Response) => {
  try {
    const { organization_id, url, secret, events = [] } = req.body ?? {}

    if (!organization_id || typeof organization_id !== 'string') {
      res.status(400).json({ error: 'organization_id is required' })
      return
    }
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'url is required' })
      return
    }
    if (!secret || typeof secret !== 'string') {
      res.status(400).json({ error: 'secret is required' })
      return
    }
    if (!Array.isArray(events)) {
      res.status(400).json({ error: 'events must be an array' })
      return
    }

    const subscriber = await upsertSubscriber(organization_id, url, secret, events)

    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'webhook.subscriber.upsert',
      target_type: 'webhook_subscriber',
      target_id: subscriber.id,
      metadata: { organizationId: organization_id, url },
    })

    // Never return the secret in responses
    res.status(200).json({
      id: subscriber.id,
      organization_id: subscriber.organizationId,
      url: subscriber.url,
      events: subscriber.events,
      active: subscriber.active,
      created_at: subscriber.createdAt,
    })
  } catch (error: any) {
    if (error?.message?.toLowerCase().includes('not permitted')) {
      res.status(422).json({ error: error.message })
      return
    }
    console.error('Error upserting webhook subscriber:', error)
    res.status(500).json({ error: 'Failed to upsert subscriber' })
  }
})

/**
 * GET /api/admin/webhooks/subscribers?organization_id=<org>
 *
 * Lists active subscribers for an organization.
 * Secret material is stripped from all responses.
 */
adminWebhooksRouter.get('/subscribers', async (req: Request, res: Response) => {
  try {
    const organizationId = req.query.organization_id as string | undefined
    if (!organizationId) {
      res.status(400).json({ error: 'organization_id query param is required' })
      return
    }

    const subscribers = await listSubscribers(organizationId)

    res.status(200).json({
      subscribers: subscribers.map((s) => ({
        id: s.id,
        organization_id: s.organizationId,
        url: s.url,
        events: s.events,
        active: s.active,
        created_at: s.createdAt,
        rotated_at: s.rotatedAt,
        field_policy: s.fieldPolicy,
      })),
    })
  } catch (error) {
    console.error('Error listing webhook subscribers:', error)
    res.status(500).json({ error: 'Failed to list subscribers' })
  }
})

/**
 * POST /api/admin/webhooks/subscribers/:id/rotate-secret
 *
 * Rotates the signing secret for a subscriber.  The previous secret is
 * preserved in a grace window (default 24 h, configurable via
 * WEBHOOK_SECRET_GRACE_WINDOW_MS) so in-flight deliveries continue to verify.
 *
 * Body: { organization_id, new_secret }
 * Response 200: { id, rotated_at }
 *   (secret material is never returned)
 */
adminWebhooksRouter.post(
  '/subscribers/:id/rotate-secret',
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { organization_id, new_secret } = req.body ?? {}

      if (!organization_id || typeof organization_id !== 'string') {
        res.status(400).json({ error: 'organization_id is required' })
        return
      }
      if (!new_secret || typeof new_secret !== 'string') {
        res.status(400).json({ error: 'new_secret is required' })
        return
      }

      const updated = await rotateSubscriberSecret(id, organization_id, new_secret)

      if (!updated) {
        // Return 404 for both "not found" and "wrong org" to avoid enumeration
        res.status(404).json({ error: 'Subscriber not found' })
        return
      }

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'webhook.subscriber.rotate_secret',
        target_type: 'webhook_subscriber',
        target_id: id,
        metadata: { organizationId: organization_id },
      })

      res.status(200).json({
        id: updated.id,
        rotated_at: updated.rotatedAt,
      })
    } catch (error) {
      console.error('Error rotating webhook subscriber secret:', error)
      res.status(500).json({ error: 'Failed to rotate secret' })
    }
  },
)

/**
 * GET /api/admin/webhooks/pause/status
 *
 * Returns the current delivery-pause state.
 */
adminWebhooksRouter.get('/pause/status', (_req: Request, res: Response) => {
  res.status(200).json({ paused: isPaused() })
})

/**
 * POST /api/admin/webhooks/pause
 *
 * Halts all outbound webhook delivery.  Events continue to accumulate in the
 * outbox and will be dispatched once the system is resumed.  Idempotent —
 * calling while already paused is a no-op.
 */
adminWebhooksRouter.post('/pause', (req: Request, res: Response) => {
  pauseDelivery()

  createAuditLog({
    actor_user_id: req.user!.userId,
    action: 'webhook.delivery.paused',
    target_type: 'webhook_global',
    target_id: 'global',
    metadata: {},
  })

  res.status(200).json({ paused: true })
})

/**
 * POST /api/admin/webhooks/resume
 *
 * Re-enables outbound webhook delivery.  The outbox relay will drain the
 * backlog on its next tick, respecting existing backoff/breaker state.
 * Idempotent — calling while already resumed is a no-op.
 */
adminWebhooksRouter.post('/resume', (req: Request, res: Response) => {
  resumeDelivery()

  createAuditLog({
    actor_user_id: req.user!.userId,
    action: 'webhook.delivery.resumed',
    target_type: 'webhook_global',
    target_id: 'global',
    metadata: {},
  })

  res.status(200).json({ paused: false })
})

// ── Egress allowlist CRUD ─────────────────────────────────────────────────────

/**
 * GET /api/admin/webhooks/egress-allowlist?organization_id=<org>
 *
 * Lists all egress allowlist entries for an organization.
 */
adminWebhooksRouter.get('/egress-allowlist', async (req: Request, res: Response) => {
  const organizationId = req.query.organization_id as string | undefined
  if (!organizationId) {
    res.status(400).json({ error: 'organization_id query param is required' })
    return
  }
  try {
    const entries = await listEgressAllowlist(organizationId)
    res.status(200).json({ egress_allowlist: entries })
  } catch (error) {
    console.error('Error listing egress allowlist:', error)
    res.status(500).json({ error: 'Failed to list egress allowlist' })
  }
})

/**
 * POST /api/admin/webhooks/egress-allowlist
 *
 * Adds a host to an org's egress allowlist. Idempotent.
 * Body: { organization_id, host }
 */
adminWebhooksRouter.post('/egress-allowlist', async (req: Request, res: Response) => {
  const { organization_id, host } = req.body ?? {}
  if (!organization_id || typeof organization_id !== 'string') {
    res.status(400).json({ error: 'organization_id is required' })
    return
  }
  if (!host || typeof host !== 'string') {
    res.status(400).json({ error: 'host is required' })
    return
  }
  try {
    const entry = await addEgressAllowlistEntry(organization_id, host)
    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'webhook.egress_allowlist.add',
      target_type: 'org_webhook_egress_allowlist',
      target_id: entry.id,
      metadata: { organizationId: organization_id, host },
    })
    res.status(201).json(entry)
  } catch (error) {
    console.error('Error adding egress allowlist entry:', error)
    res.status(500).json({ error: 'Failed to add egress allowlist entry' })
  }
})

/**
 * DELETE /api/admin/webhooks/egress-allowlist
 *
 * Removes a host from an org's egress allowlist.
 * Body: { organization_id, host }
 */
adminWebhooksRouter.delete('/egress-allowlist', async (req: Request, res: Response) => {
  const { organization_id, host } = req.body ?? {}
  if (!organization_id || typeof organization_id !== 'string') {
    res.status(400).json({ error: 'organization_id is required' })
    return
  }
  if (!host || typeof host !== 'string') {
    res.status(400).json({ error: 'host is required' })
    return
  }
  try {
    const removed = await removeEgressAllowlistEntry(organization_id, host)
    if (!removed) {
      res.status(404).json({ error: 'Entry not found' })
      return
    }
    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'webhook.egress_allowlist.remove',
      target_type: 'org_webhook_egress_allowlist',
      target_id: `${organization_id}:${host}`,
      metadata: { organizationId: organization_id, host },
    })
    res.status(200).json({ removed: true })
  } catch (error) {
    console.error('Error removing egress allowlist entry:', error)
    res.status(500).json({ error: 'Failed to remove egress allowlist entry' })
  }
})

/**
 * PATCH /api/admin/webhooks/subscribers/:id/field-policy
 *
 * Updates the field masking policy for a subscriber. The policy controls
 * which fields are included in webhook payloads and whether PII is stripped.
 *
 * Body: { organization_id, field_policy: { mode, fields, stripPii } }
 * Response 200: { id, field_policy }
 */
adminWebhooksRouter.patch(
  '/subscribers/:id/field-policy',
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { organization_id, field_policy } = req.body ?? {}

      if (!organization_id || typeof organization_id !== 'string') {
        res.status(400).json({ error: 'organization_id is required' })
        return
      }
      if (!field_policy || !isValidFieldPolicy(field_policy)) {
        res.status(400).json({
          error: 'field_policy must be an object with mode ("default", "allowlist", or "denylist"), fields (string array), and stripPii (boolean)',
        })
        return
      }

      const updated = await updateSubscriberFieldPolicy(id, organization_id, field_policy)

      if (!updated) {
        res.status(404).json({ error: 'Subscriber not found' })
        return
      }

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'webhook.subscriber.update_field_policy',
        target_type: 'webhook_subscriber',
        target_id: id,
        metadata: {
          organizationId: organization_id,
          fieldPolicy: field_policy,
        },
      })

      res.status(200).json({
        id: updated.id,
        field_policy: updated.fieldPolicy,
      })
    } catch (error) {
      console.error('Error updating webhook subscriber field policy:', error)
      res.status(500).json({ error: 'Failed to update field policy' })
    }
  },
)

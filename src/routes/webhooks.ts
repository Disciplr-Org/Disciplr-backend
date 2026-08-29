import { randomUUID } from 'node:crypto'
import { Router, type NextFunction, type Response } from 'express'
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { formatValidationError } from '../lib/validation.js'
import { webhookCreateSchema, webhookRotateSchema } from '../types/webhook.js'
import {
  addSubscriber,
  listSubscribers,
  removeSubscriberForOrg,
  rotateSubscriberSecret,
  isUrlAllowed,
} from '../services/webhooks.js'

/**
 * Subscriber ids are server-generated UUIDs. Route params must match this
 * shape at the boundary so garbage ids are rejected with 400 before any store
 * query (no wasted lookups, no injection into downstream string matching).
 */
const WEBHOOK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Rejects a malformed `:id` route parameter (missing or non-UUID) with 400.
 */
const validateWebhookIdParam = (id: string | undefined, next: NextFunction): id is string => {
  if (typeof id !== 'string' || !WEBHOOK_ID_PATTERN.test(id)) {
    next(AppError.validation('Invalid webhook subscription id', { field: 'id' }))
    return false
  }
  return true
}

const serializeSubscription = (subscription: { id: string; url: string; events: string[]; active: boolean; orgId?: string; createdAt: string }) => ({
  id: subscription.id,
  url: subscription.url,
  events: subscription.events,
  active: subscription.active,
  orgId: subscription.orgId,
  createdAt: subscription.createdAt,
})

export const webhookRouter = Router()

webhookRouter.use(authenticate)

webhookRouter.post(
  '/',
  requireOrgAccess('owner', 'admin', 'member'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parseResult = webhookCreateSchema.safeParse(req.body)
      if (!parseResult.success) {
        return next(AppError.validation('Invalid request payload', formatValidationError(parseResult.error)))
      }

      const { url, events, active } = parseResult.data
      if (!isUrlAllowed(url)) {
        return next(AppError.validation('Webhook URL not permitted', { field: 'url' }))
      }

      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      const secret = randomUUID().replace(/-/g, '')
      const subscription = await addSubscriber(orgId, url, secret, events)

      return res.status(201).json({
        secret,
        subscription: {
          id: subscription.id,
          url: subscription.url,
          events: subscription.events,
          active: subscription.active,
          orgId: subscription.orgId,
          createdAt: subscription.createdAt,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

webhookRouter.get(
  '/',
  requireOrgAccess('owner', 'admin', 'member'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      const subscriptions = (await listSubscribers(orgId)).map((subscription) => serializeSubscription(subscription))
      return res.json({ subscriptions })
    } catch (error) {
      return next(error)
    }
  },
)

webhookRouter.get(
  '/:id',
  requireOrgAccess('owner', 'admin', 'member'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!validateWebhookIdParam(req.params.id, next)) return

      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      const subs = await listSubscribers(orgId)
      const subscription = subs.find((item) => item.id === req.params.id)
      if (!subscription) {
        return next(AppError.notFound('Webhook subscription not found'))
      }

      return res.json({ subscription: serializeSubscription(subscription) })
    } catch (error) {
      return next(error)
    }
  },
)

webhookRouter.post(
  '/:id/rotate-secret',
  requireOrgAccess('owner', 'admin', 'member'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!validateWebhookIdParam(req.params.id, next)) return

      const parseResult = webhookRotateSchema.safeParse(req.body)
      if (!parseResult.success) {
        return next(AppError.validation('Invalid request payload', formatValidationError(parseResult.error)))
      }

      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      const subs = await listSubscribers(orgId)
      const subscription = subs.find((item) => item.id === req.params.id)
      if (!subscription) {
        return next(AppError.notFound('Webhook subscription not found'))
      }

      const secret = randomUUID().replace(/-/g, '')
      const updated = await rotateSubscriberSecret(req.params.id, secret, orgId)
      if (!updated) {
        return next(AppError.notFound('Webhook subscription not found'))
      }

      return res.json({ secret, subscription: serializeSubscription(updated) })
    } catch (error) {
      return next(error)
    }
  },
)

webhookRouter.delete(
  '/:id',
  requireOrgAccess('owner', 'admin', 'member'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!validateWebhookIdParam(req.params.id, next)) return

      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      // Ownership is enforced server-side: only a subscriber that belongs to
      // the caller's organization can be deleted. A member of org A attempting
      // to delete a subscriber owned by org B gets a non-committal 404.
      const deleted = await removeSubscriberForOrg(req.params.id, orgId)
      if (!deleted) {
        return next(AppError.notFound('Webhook subscription not found'))
      }

      return res.json({ deleted: true })
    } catch (error) {
      return next(error)
    }
  },
)

export default webhookRouter

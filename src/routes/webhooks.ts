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
  removeSubscriber,
  rotateSubscriberSecret,
  isUrlAllowed,
  type WebhookSubscriber,
} from '../services/webhooks.js'

const serializeSubscription = (subscription: WebhookSubscriber) => ({
  id: subscription.id,
  url: subscription.url,
  events: subscription.events,
  active: subscription.active,
  orgId: subscription.orgId ?? subscription.organizationId,
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

      const { url, events } = parseResult.data
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
        subscription: serializeSubscription(subscription),
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

      const subscribers = await listSubscribers(orgId)
      return res.json({ subscriptions: subscribers.map(serializeSubscription) })
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
      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      const subscribers = await listSubscribers(orgId)
      const subscription = subscribers.find((item) => item.id === req.params.id)
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
      const parseResult = webhookRotateSchema.safeParse(req.body)
      if (!parseResult.success) {
        return next(AppError.validation('Invalid request payload', formatValidationError(parseResult.error)))
      }

      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      const secret = randomUUID().replace(/-/g, '')
      const updated = await rotateSubscriberSecret(req.params.id, orgId, secret)
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
      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      // Scope the delete to the caller's organization before removing.
      const subscribers = await listSubscribers(orgId)
      const subscription = subscribers.find((item) => item.id === req.params.id)
      if (!subscription) {
        return next(AppError.notFound('Webhook subscription not found'))
      }

      const deleted = await removeSubscriber(req.params.id)
      if (!deleted) {
        return next(AppError.notFound('Webhook subscription not found'))
      }

      return res.json({ deleted: true })
    } catch (error) {
      return next(error)
    }
  },
)

// Some consumers import this router under the plural name.
export const webhooksRouter = webhookRouter

export default webhookRouter

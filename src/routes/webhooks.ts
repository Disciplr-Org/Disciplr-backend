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
  updateSubscriberSecret,
  isUrlAllowed,
} from '../services/webhooks.js'

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
      const subscription = addSubscriber(url, secret, events, orgId, active)

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

      const subscriptions = listSubscribers(orgId).map((subscription) => serializeSubscription(subscription))
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
      const orgId = req.query.orgId as string | undefined
      if (!orgId) {
        return next(AppError.badRequest('orgId is required'))
      }

      const subscription = listSubscribers(orgId).find((item) => item.id === req.params.id)
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

      const subscription = listSubscribers(orgId).find((item) => item.id === req.params.id)
      if (!subscription) {
        return next(AppError.notFound('Webhook subscription not found'))
      }

      const secret = randomUUID().replace(/-/g, '')
      const updated = updateSubscriberSecret(req.params.id, secret, orgId)
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

      const deleted = removeSubscriber(req.params.id, orgId)
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

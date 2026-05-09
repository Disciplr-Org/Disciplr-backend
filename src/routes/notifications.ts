import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { queryParser } from '../middleware/queryParser.js'
import type {
  NotificationReadStatus,
  NotificationSortField,
} from '../types/notification.js'
import {
  listUserNotifications,
  markAllAsRead,
  markAsRead,
} from '../services/notification.js'
import { AppError } from '../middleware/errorHandler.js'

const DEFAULT_SORT_BY: NotificationSortField = 'created_at'
const DEFAULT_SORT_ORDER = 'desc' as const
const ALLOWED_STATUSES: NotificationReadStatus[] = ['all', 'read', 'unread']

export const notificationsRouter = Router()

notificationsRouter.use(authenticate)

notificationsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['created_at', 'read_at', 'title', 'type'],
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(AppError.unauthorized('Unauthenticated'))
    }

    const rawStatus = String(req.query.status ?? 'all').toLowerCase() as NotificationReadStatus
    if (!ALLOWED_STATUSES.includes(rawStatus)) {
      return next(AppError.badRequest('Invalid status filter. Use all, read, or unread.'))
    }

    const includeArchived = ['true', '1'].includes(String(req.query.includeArchived ?? '').toLowerCase())

    const notifications = await listUserNotifications(req.user!.userId)

    res.json(notifications)
  },
)

notificationsRouter.patch('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return next(AppError.unauthorized('Unauthenticated'))
  }

  const notification = await markAsRead(req.params.id, req.user.userId)

  if (!notification) {
    return next(AppError.notFound('Notification not found'))
  }

  res.json(notification)
})

notificationsRouter.post('/read-all', async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return next(AppError.unauthorized('Unauthenticated'))
  }

  const updated = await markAllAsRead(req.user.userId)
  res.json({ updated })
})


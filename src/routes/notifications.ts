import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import {
  listUserNotifications,
  markAsRead,
  markAllAsRead,
} from '../services/notification.js'

export const notificationsRouter = Router()

// All notifications routes require authentication
notificationsRouter.use(authenticate)

// GET /api/notifications - List current user's notifications
notificationsRouter.get('/', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' })
    return
  }
  const notifications = await listUserNotifications(req.user.userId)
  res.json(notifications)
})

// PATCH /api/notifications/:id/read - Mark a notification as read
notificationsRouter.patch('/:id/read', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' })
    return
  }
  const { id } = req.params
  const notification = await markAsRead(id, req.user.userId)
  
  if (!notification) {
    res.status(404).json({ error: 'Notification not found' })
    return
  }
  
  res.json(notification)
})

// POST /api/notifications/read-all - Mark all as read
notificationsRouter.post('/read-all', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' })
    return
  }
  const count = await markAllAsRead(req.user.userId)
  res.json({ message: `Marked ${count} notifications as read` })
})

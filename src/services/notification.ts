import db from '../db/index.js'
import type { Notification, CreateNotificationInput } from '../types/notification.js'

export const createNotification = async (input: CreateNotificationInput): Promise<Notification> => {
  const [notification] = await db('notifications')
    .insert({
      user_id: input.user_id,
      type: input.type,
      title: input.title,
      message: input.message,
      data: input.data ? JSON.stringify(input.data) : null,
    })
    .returning('*')
  return notification
}

export const listUserNotifications = async (userId: string): Promise<Notification[]> => {
  return db('notifications')
    .where({ user_id: userId })
    .orderBy('created_at', 'desc')
    .select('*')
}

export const markAsRead = async (id: string, userId: string): Promise<Notification | null> => {
  const [notification] = await db('notifications')
    .where({ id, user_id: userId })
    .update({ read_at: new Date().toISOString() })
    .returning('*')
  return notification || null
}

export const markAllAsRead = async (userId: string): Promise<number> => {
  return db('notifications')
    .where({ user_id: userId, read_at: null })
    .update({ read_at: new Date().toISOString() })
}

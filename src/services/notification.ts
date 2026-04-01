import { db } from '../db/index.js'
import type { Notification, CreateNotificationInput } from '../types/notification.js'

// Minimal structured logger — emits JSON to stdout, no PII (no user_id, title, message)
const log = {
  debug: (event: string, fields: { idempotency_key: string; id: string }) => {
    try {
      console.debug(JSON.stringify({ level: 'debug', event, ...fields }))
    } catch {
      // swallow logger errors
    }
  },
  info: (event: string, fields: { idempotency_key: string; id: string }) => {
    try {
      console.info(JSON.stringify({ level: 'info', event, ...fields }))
    } catch {
      // swallow logger errors
    }
  },
}

export const createNotification = async (input: CreateNotificationInput): Promise<Notification> => {
  const row: Record<string, unknown> = {
    user_id: input.user_id,
    type: input.type,
    title: input.title,
    message: input.message,
    data: input.data ? JSON.stringify(input.data) : null,
  }
  if (input.idempotency_key !== undefined) {
    row.idempotency_key = input.idempotency_key
  }

  try {
    const [notification] = await db('notifications').insert(row).returning('*')
    if (input.idempotency_key) {
      log.debug('notification_created_with_key', {
        idempotency_key: input.idempotency_key,
        id: notification.id,
      })
    }
    return notification
  } catch (err: any) {
    if (err.code === '23505' && input.idempotency_key) {
      const existing = await db('notifications')
        .where({ user_id: input.user_id, idempotency_key: input.idempotency_key })
        .first()
      if (!existing) {
        throw err
      }
      try {
        log.info('notification_dedupe_suppressed', {
          idempotency_key: input.idempotency_key,
          id: existing.id,
        })
      } catch {
        // swallow logger errors
      }
      return existing
    }
    throw err
  }
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

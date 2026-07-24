import db from '../db/index.js'
import type {
  Notification,
  CreateNotificationInput,
  NotificationListOptions,
  NotificationListResult,
} from '../types/notification.js'
import { isNotificationEnabled } from '../models/notificationPreferences.js'
import { decodeCursor, encodeCursor } from '../utils/pagination.js'

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

export const createNotification = async (input: CreateNotificationInput): Promise<Notification | null> => {
  const channel = input.channel ?? 'email'
  const enabled = await isNotificationEnabled(input.organization_id, input.type, channel)
  if (!enabled) {
    return null
  }

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

export const listUserNotifications = async (
  userId: string,
  options: NotificationListOptions,
): Promise<NotificationListResult> => {
  const query = db('notifications')
    .where({ user_id: userId })
    .modify((builder) => {
      if (!options.includeArchived) {
        builder.whereNull('archived_at')
      }

      if (options.readStatus === 'read') {
        builder.whereNotNull('read_at')
      } else if (options.readStatus === 'unread') {
        builder.whereNull('read_at')
      }
    })

  if (options.cursor) {
    const { timestamp, id } = decodeCursor(options.cursor)
    query.where(function () {
      this.where('created_at', '<', timestamp)
        .orWhere(function () {
          this.where('created_at', '=', timestamp).andWhere('id', '<', id)
        })
    })
  }

  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit + 1)
    .select('*')

  const hasMore = rows.length > options.limit
  const data = rows.slice(0, options.limit)
  const nextCursor =
    hasMore && data.length > 0
      ? encodeCursor(new Date(data[data.length - 1].created_at), data[data.length - 1].id)
      : undefined

  return {
    data,
    pagination: {
      limit: options.limit,
      cursor: options.cursor ?? null,
      next_cursor: nextCursor,
      has_more: hasMore,
      count: data.length,
    },
  }
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

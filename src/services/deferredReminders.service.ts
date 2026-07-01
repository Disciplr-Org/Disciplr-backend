/**
 * Service for managing deferred reminder storage and retrieval.
 * Deferred reminders are stored when a notification falls within quiet hours
 * and processed later when the quiet-hours window ends.
 */
import db from '../db/index.js'
import type { DigestPayload, DeferredReminder } from '../types/notification.js'

const TABLE = 'deferred_reminders'

/**
 * Stores a deferred reminder for later delivery.
 * Uses upsert to handle idempotency - if a reminder with the same key exists,
 * it updates the deliver_after time.
 */
export async function storeDeferredReminder(
  userId: string,
  idempotencyKey: string,
  payload: DigestPayload,
  deliverAfter: Date
): Promise<DeferredReminder> {
  const now = new Date().toISOString()
  const deliverAfterIso = deliverAfter.toISOString()

  // Try to insert, on conflict update the deliver_after time
  const result = await db(TABLE)
    .insert({
      user_id: userId,
      idempotency_key: idempotencyKey,
      reminder_data: JSON.stringify(payload),
      deliver_after: deliverAfterIso,
      created_at: now,
    })
    .onConflict(['user_id', 'idempotency_key'])
    .merge({
      reminder_data: JSON.stringify(payload),
      deliver_after: deliverAfterIso,
    })
    .returning('*')

  return mapRowToDeferred(result[0])
}

/**
 * Claims deferred reminders that are due for delivery.
 * Uses FOR UPDATE SKIP LOCKED to prevent concurrent processing.
 * Returns reminders with deliver_after <= now.
 */
export async function claimDueReminders(limit: number = 50): Promise<DeferredReminder[]> {
  const now = new Date().toISOString()

  // Use a transaction to claim and return the reminders atomically
  const reminders = await db.transaction(async (trx) => {
    // Select reminders that are due, with SKIP LOCKED to avoid contention
    const rows = await trx(TABLE)
      .where('deliver_after', '<=', now)
      .orderBy('deliver_after', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .select('*')

    if (rows.length === 0) {
      return []
    }

    // Delete the claimed reminders
    const ids = rows.map(r => r.id)
    await trx(TABLE)
      .whereIn('id', ids)
      .delete()

    return rows.map(mapRowToDeferred)
  })

  return reminders
}

/**
 * Gets a deferred reminder by user ID and idempotency key.
 * Returns null if not found.
 */
export async function getDeferredByKey(
  userId: string,
  idempotencyKey: string
): Promise<DeferredReminder | null> {
  const row = await db(TABLE)
    .where('user_id', userId)
    .andWhere('idempotency_key', idempotencyKey)
    .first()

  return row ? mapRowToDeferred(row) : null
}

/**
 * Deletes a specific deferred reminder by ID.
 */
export async function deleteDeferredReminder(id: string): Promise<boolean> {
  const deleted = await db(TABLE)
    .where('id', id)
    .delete()

  return deleted > 0
}

/**
 * Gets the count of pending deferred reminders.
 * Useful for monitoring and metrics.
 */
export async function getPendingCount(): Promise<number> {
  const result = await db(TABLE)
    .count('id as count')
    .first()

  return Number(result?.count ?? 0)
}

/**
 * Gets the count of deferred reminders that are due for delivery.
 */
export async function getDueCount(): Promise<number> {
  const now = new Date().toISOString()
  const result = await db(TABLE)
    .where('deliver_after', '<=', now)
    .count('id as count')
    .first()

  return Number(result?.count ?? 0)
}

/**
 * Maps a database row to the DeferredReminder interface.
 */
function mapRowToDeferred(row: Record<string, unknown>): DeferredReminder {
  const reminderData = typeof row.reminder_data === 'string'
    ? JSON.parse(row.reminder_data)
    : row.reminder_data

  return {
    id: String(row.id),
    user_id: String(row.user_id),
    idempotency_key: String(row.idempotency_key),
    reminder_data: reminderData as DigestPayload,
    deliver_after: String(row.deliver_after),
    created_at: String(row.created_at),
  }
}

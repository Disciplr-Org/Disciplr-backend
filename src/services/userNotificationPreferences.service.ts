/**
 * Service for managing user notification preferences including quiet hours.
 */
import db from '../db/index.js'
import type {
  UserNotificationPreferences,
  UpsertUserNotificationPreferencesInput,
} from '../types/notification.js'
import { isValidTimezone, isValidTimeFormat } from '../utils/quietHours.js'

const TABLE = 'user_notification_preferences'

/**
 * Default preferences for users without stored preferences.
 */
export function getDefaultPreferences(userId: string): UserNotificationPreferences {
  const now = new Date().toISOString()
  return {
    id: null,
    user_id: userId,
    timezone: 'UTC',
    quiet_hours_enabled: false,
    quiet_hours_start: '22:00',
    quiet_hours_end: '08:00',
    created_at: now,
    updated_at: now,
  }
}

/**
 * Retrieves user notification preferences by user ID.
 * Returns default preferences if none exist.
 */
export async function getUserPreferences(userId: string): Promise<UserNotificationPreferences> {
  const row = await db(TABLE)
    .where('user_id', userId)
    .first()

  if (!row) {
    return getDefaultPreferences(userId)
  }

  return mapRowToPreferences(row)
}

/**
 * Retrieves notification preferences for multiple users in a single query.
 * Returns a Map keyed by user_id. Users without preferences get defaults.
 */
export async function getUserPreferencesBatch(
  userIds: string[]
): Promise<Map<string, UserNotificationPreferences>> {
  if (userIds.length === 0) {
    return new Map()
  }

  const uniqueIds = [...new Set(userIds)]
  const rows = await db(TABLE)
    .whereIn('user_id', uniqueIds)
    .select('*')

  const result = new Map<string, UserNotificationPreferences>()

  // Add found preferences
  for (const row of rows) {
    result.set(row.user_id, mapRowToPreferences(row))
  }

  // Add defaults for users without preferences
  for (const userId of uniqueIds) {
    if (!result.has(userId)) {
      result.set(userId, getDefaultPreferences(userId))
    }
  }

  return result
}

/**
 * Creates or updates user notification preferences.
 * Validates timezone and time format before saving.
 */
export async function upsertUserPreferences(
  userId: string,
  input: UpsertUserNotificationPreferencesInput
): Promise<UserNotificationPreferences> {
  // Validate timezone if provided
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new Error(`Invalid timezone: ${input.timezone}`)
  }

  // Validate time formats if provided
  if (input.quiet_hours_start !== undefined && !isValidTimeFormat(input.quiet_hours_start)) {
    throw new Error(`Invalid quiet_hours_start format: ${input.quiet_hours_start}. Expected HH:MM.`)
  }

  if (input.quiet_hours_end !== undefined && !isValidTimeFormat(input.quiet_hours_end)) {
    throw new Error(`Invalid quiet_hours_end format: ${input.quiet_hours_end}. Expected HH:MM.`)
  }

  const defaults = getDefaultPreferences(userId)

  // Build the insert data with defaults for missing fields
  const insertData = {
    user_id: userId,
    timezone: input.timezone ?? defaults.timezone,
    quiet_hours_enabled: input.quiet_hours_enabled ?? defaults.quiet_hours_enabled,
    quiet_hours_start: input.quiet_hours_start ?? defaults.quiet_hours_start,
    quiet_hours_end: input.quiet_hours_end ?? defaults.quiet_hours_end,
    created_at: db.fn.now(),
    updated_at: db.fn.now(),
  }

  // Build the merge data (only includes fields that might be updated)
  const mergeData: Record<string, unknown> = {
    updated_at: db.fn.now(),
  }
  if (input.timezone !== undefined) mergeData.timezone = input.timezone
  if (input.quiet_hours_enabled !== undefined) mergeData.quiet_hours_enabled = input.quiet_hours_enabled
  if (input.quiet_hours_start !== undefined) mergeData.quiet_hours_start = input.quiet_hours_start
  if (input.quiet_hours_end !== undefined) mergeData.quiet_hours_end = input.quiet_hours_end

  const [result] = await db(TABLE)
    .insert(insertData)
    .onConflict('user_id')
    .merge(mergeData)
    .returning('*')

  return mapRowToPreferences(result)
}

/**
 * Deletes user notification preferences.
 * User will revert to default preferences.
 */
export async function deleteUserPreferences(userId: string): Promise<boolean> {
  const deleted = await db(TABLE)
    .where('user_id', userId)
    .delete()

  return deleted > 0
}

/**
 * Maps a database row to the UserNotificationPreferences interface.
 */
function mapRowToPreferences(row: Record<string, unknown>): UserNotificationPreferences {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    timezone: String(row.timezone),
    quiet_hours_enabled: Boolean(row.quiet_hours_enabled),
    quiet_hours_start: String(row.quiet_hours_start),
    quiet_hours_end: String(row.quiet_hours_end),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

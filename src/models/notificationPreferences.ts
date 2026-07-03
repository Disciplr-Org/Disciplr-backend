import db from '../db/index.js'

// Sentinel category value meaning "every category on this channel" — used to
// represent a whole-channel opt-out without one row per known category.
const ALL_CATEGORIES = ''

export const ALLOWED_CATEGORIES = ['vault_failure', 'milestone_reminder'] as const
export type NotificationCategory = (typeof ALLOWED_CATEGORIES)[number]

export const ALLOWED_CHANNELS = ['email'] as const
export type NotificationChannel = (typeof ALLOWED_CHANNELS)[number]

export interface OrgNotificationPreferences {
  organizationId: string
  categories: Record<NotificationCategory, boolean>
  channels: Record<NotificationChannel, boolean>
}

export interface NotificationPreferencesInput {
  categories?: Partial<Record<string, boolean>>
  channels?: Partial<Record<string, boolean>>
}

export class UnknownPreferenceKeyError extends Error {
  constructor(kind: 'category' | 'channel', key: string) {
    super(`Unknown ${kind}: ${key}`)
  }
}

interface PreferenceRow {
  category: string
  channel: string
  enabled: boolean
}

function defaultCategories(): Record<NotificationCategory, boolean> {
  return Object.fromEntries(ALLOWED_CATEGORIES.map((c) => [c, true])) as Record<NotificationCategory, boolean>
}

function defaultChannels(): Record<NotificationChannel, boolean> {
  return Object.fromEntries(ALLOWED_CHANNELS.map((c) => [c, true])) as Record<NotificationChannel, boolean>
}

export async function getOrgNotificationPreferences(organizationId: string): Promise<OrgNotificationPreferences> {
  const rows: PreferenceRow[] = await db('org_notification_preferences')
    .where({ organization_id: organizationId })
    .select('category', 'channel', 'enabled')

  const categories = defaultCategories()
  const channels = defaultChannels()

  for (const row of rows) {
    if (row.category === ALL_CATEGORIES) {
      if ((ALLOWED_CHANNELS as readonly string[]).includes(row.channel)) {
        channels[row.channel as NotificationChannel] = row.enabled
      }
    } else if ((ALLOWED_CATEGORIES as readonly string[]).includes(row.category)) {
      categories[row.category as NotificationCategory] = row.enabled
    }
  }

  return { organizationId, categories, channels }
}

export async function setOrgNotificationPreferences(
  organizationId: string,
  input: NotificationPreferencesInput,
): Promise<OrgNotificationPreferences> {
  const rows: { organization_id: string; category: string; channel: string; enabled: boolean }[] = []

  for (const [category, enabled] of Object.entries(input.categories ?? {})) {
    if (!(ALLOWED_CATEGORIES as readonly string[]).includes(category)) {
      throw new UnknownPreferenceKeyError('category', category)
    }
    rows.push({ organization_id: organizationId, category, channel: 'email', enabled: enabled! })
  }

  for (const [channel, enabled] of Object.entries(input.channels ?? {})) {
    if (!(ALLOWED_CHANNELS as readonly string[]).includes(channel)) {
      throw new UnknownPreferenceKeyError('channel', channel)
    }
    rows.push({ organization_id: organizationId, category: ALL_CATEGORIES, channel, enabled: enabled! })
  }

  if (rows.length > 0) {
    await db('org_notification_preferences')
      .insert(rows)
      .onConflict(['organization_id', 'category', 'channel'])
      .merge(['enabled', 'updated_at'])
  }

  return getOrgNotificationPreferences(organizationId)
}

/**
 * Consulted by the dispatch path before a notification is created. A
 * category-specific row always wins over the whole-channel row, which in
 * turn wins over the all-enabled default.
 */
export async function isNotificationEnabled(
  organizationId: string | null | undefined,
  category: string,
  channel: string = 'email',
): Promise<boolean> {
  if (!organizationId) return true

  const rows: PreferenceRow[] = await db('org_notification_preferences')
    .where({ organization_id: organizationId, channel })
    .whereIn('category', [category, ALL_CATEGORIES])
    .select('category', 'enabled')

  const categoryRow = rows.find((r) => r.category === category)
  if (categoryRow) return categoryRow.enabled

  const channelRow = rows.find((r) => r.category === ALL_CATEGORIES)
  if (channelRow) return channelRow.enabled

  return true
}

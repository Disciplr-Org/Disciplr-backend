/**
 * Renders digest notification content from multiple milestone items.
 * Formats reminder items into human-readable titles and messages.
 */
import type { MilestoneReminderItem } from '../types/notification.js'
import { formatTimestamp } from '../utils/timestamps.js'

export interface RenderDigestOptions {
  items: MilestoneReminderItem[]
  locale?: string
  timezone?: string
}

/**
 * Renders the title for a digest notification.
 * Single item: "Milestone Reminder: {title}"
 * Multiple items: "{n} Milestone Reminders"
 */
export function renderDigestTitle(items: MilestoneReminderItem[]): string {
  if (items.length === 0) {
    return 'No Milestone Reminders'
  }

  if (items.length === 1) {
    return `Milestone Reminder: ${items[0].milestone_title}`
  }

  return `${items.length} Milestone Reminders`
}

/**
 * Renders the message body for a digest notification.
 * Lists all milestones with their due dates and time remaining.
 */
export function renderDigestMessage(options: RenderDigestOptions): string {
  const { items, locale = 'en-US', timezone = 'UTC' } = options

  if (items.length === 0) {
    return 'You have no upcoming milestone deadlines.'
  }

  if (items.length === 1) {
    const item = items[0]
    const dueFormatted = formatTimestamp(item.due_date, { locale, timeZone: timezone, style: 'medium' })
    return `Your milestone "${item.milestone_title}" is due in ${item.lead_time_text}! (${dueFormatted})\n\nDon't forget to check in before the deadline to avoid a slash.`
  }

  // Multiple items - create a list
  const lines = [
    'You have upcoming milestone deadlines:',
    '',
  ]

  for (const item of items) {
    const dueFormatted = formatTimestamp(item.due_date, { locale, timeZone: timezone, style: 'short' })
    lines.push(`• ${item.milestone_title} - due in ${item.lead_time_text} (${dueFormatted})`)
  }

  lines.push('')
  lines.push("Don't forget to check in before the deadlines to avoid slashes.")

  return lines.join('\n')
}

/**
 * Converts a lead time in milliseconds to a human-readable string.
 */
export function formatLeadTime(leadTimeMs: number): string {
  const hours = leadTimeMs / (60 * 60 * 1000)

  if (hours < 1) {
    const minutes = Math.round(leadTimeMs / (60 * 1000))
    return minutes === 1 ? '1 minute' : `${minutes} minutes`
  }

  if (hours === 1) {
    return '1 hour'
  }

  if (hours < 24) {
    return `${Math.round(hours)} hours`
  }

  const days = hours / 24
  if (days === 1) {
    return '1 day'
  }

  return `${Math.round(days)} days`
}

/**
 * Creates the data payload for a digest notification.
 */
export function createDigestData(items: MilestoneReminderItem[]): Record<string, unknown> {
  return {
    digestType: 'milestone_reminders',
    itemCount: items.length,
    items: items.map(item => ({
      vaultId: item.vault_id,
      milestoneId: item.milestone_id,
      dueDate: item.due_date,
      leadTimeMs: item.lead_time_ms,
    })),
  }
}

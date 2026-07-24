import db from '../db/index.js'
import { createNotification } from './notification.js'
import { getUserPreferencesBatch } from './userNotificationPreferences.service.js'
import { storeDeferredReminder, claimDueReminders } from './deferredReminders.service.js'
import {
  renderDigestTitle,
  renderDigestMessage,
  formatLeadTime,
  createDigestData,
} from './digestRenderer.js'
import { isInQuietHours, getQuietHoursEndUTC } from '../utils/quietHours.js'
import type { MilestoneReminderItem, DigestPayload } from '../types/notification.js'

// Configurable lead times in milliseconds (72h, 24h, 1h by default)
const DEFAULT_LEAD_TIMES_MS = [
  72 * 60 * 60 * 1000, // 72 hours
  24 * 60 * 60 * 1000, // 24 hours
  1 * 60 * 60 * 1000,  // 1 hour
]

export const markVaultExpiries = async (
  opts: { now?: Date; limit?: number } = {}
): Promise<number> => {
  const now = (opts.now ?? new Date()).toISOString()

  const query = db('vaults')
    .where('status', 'active')
    .andWhere('end_date', '<=', now)

  if (opts.limit) {
    query.limit(opts.limit)
  }

  const expiredVaults = await query.select('*')

  if (expiredVaults.length === 0) return 0

  const expiredIds = expiredVaults.map(v => v.id)

  await db('vaults')
    .whereIn('id', expiredIds)
    .where('status', 'active')
    .update({ status: 'failed' })

  for (const vault of expiredVaults) {
    await createNotification({
      user_id: vault.creator,
      type: 'vault_failure',
      title: 'Vault Deadline Reached',
      message: 'A vault in your account has expired and been marked as failed.',
      data: { vaultId: vault.id },
      organization_id: vault.organization_id
    })
  }

  return expiredVaults.length
}

export const sendMilestoneReminders = async (
  opts: { now?: Date; leadTimesMs?: number[]; limit?: number } = {}
): Promise<number> => {
  const now = opts.now ?? new Date()
  const leadTimesMs = opts.leadTimesMs ?? DEFAULT_LEAD_TIMES_MS
  const nowMs = now.getTime()

  // Get active vaults with their milestones
  const vaultMilestones = await db('vaults')
    .join('milestones', 'vaults.id', '=', 'milestones.vault_id')
    .where('vaults.status', 'active')
    .whereIn('milestones.status', ['pending'])
    .whereNotNull('milestones.due_date')
    .select(
      'vaults.id as vault_id',
      'vaults.creator as user_id',
      'vaults.organization_id as organization_id',
      'milestones.id as milestone_id',
      'milestones.title as milestone_title',
      'milestones.due_date'
    )

  let remindersSent = 0

  for (const vm of vaultMilestones) {
    if (opts.limit && remindersSent >= opts.limit) break

    const dueDate = new Date(vm.due_date)
    const dueDateMs = dueDate.getTime()
    const timeUntilDue = dueDateMs - nowMs

    // Find which lead time buckets this milestone falls into
    for (const leadTimeMs of leadTimesMs) {
      // Only send reminder if we're within the lead time window
      if (timeUntilDue > 0 && timeUntilDue <= leadTimeMs) {
        // Create idempotency key to avoid duplicate reminders
        const idempotencyKey = `milestone-reminder-${vm.milestone_id}-${leadTimeMs}`
        
        // Convert lead time to human-readable string
        const leadTimeHours = leadTimeMs / (60 * 60 * 1000)
        const leadTimeText = leadTimeHours === 1 ? '1 hour' : `${leadTimeHours} hours`

        try {
          await createNotification({
            user_id: vm.user_id,
            type: 'milestone_reminder',
            title: `Milestone Reminder: ${vm.milestone_title}`,
            message: `Your milestone is due in ${leadTimeText}! Don't forget to check in before the deadline to avoid a slash.`,
            data: {
              vaultId: vm.vault_id,
              milestoneId: vm.milestone_id,
              dueDate: vm.due_date,
              leadTimeMs
            },
            idempotency_key: idempotencyKey,
            organization_id: vm.organization_id
          })
          remindersSent++
        } catch (err) {
          // Ignore duplicate notifications (idempotency key collision)
          console.debug(`[milestone-reminder] Skipping duplicate reminder for milestone ${vm.milestone_id}`, err)
        }
        // Break after first matching lead time to avoid sending multiple reminders for the same milestone
        break
      }
    }
  }

  return remindersSent
}

export interface DigestRemindersResult {
  digestsSent: number
  digestsDeferred: number
  totalMilestones: number
}

/**
 * Sends milestone reminders as batched digests per user.
 * Groups all pending reminders for the same recipient into a single notification.
 * Respects quiet-hours windowing - defers delivery until an acceptable local time.
 */
export const sendMilestoneDigestReminders = async (
  opts: { now?: Date; leadTimesMs?: number[]; limit?: number } = {}
): Promise<DigestRemindersResult> => {
  const now = opts.now ?? new Date()
  const leadTimesMs = opts.leadTimesMs ?? DEFAULT_LEAD_TIMES_MS
  const nowMs = now.getTime()

  // Phase 1: Query all pending milestones
  const vaultMilestones = await db('vaults')
    .join('milestones', 'vaults.id', '=', 'milestones.vault_id')
    .where('vaults.status', 'active')
    .whereIn('milestones.status', ['pending'])
    .whereNotNull('milestones.due_date')
    .select(
      'vaults.id as vault_id',
      'vaults.creator as user_id',
      'milestones.id as milestone_id',
      'milestones.title as milestone_title',
      'milestones.due_date'
    )

  // Phase 2: Group by user_id and filter by lead time
  const userReminders = new Map<string, MilestoneReminderItem[]>()
  const seenMilestoneKeys = new Set<string>()

  for (const vm of vaultMilestones) {
    const dueDate = new Date(vm.due_date)
    const dueDateMs = dueDate.getTime()
    const timeUntilDue = dueDateMs - nowMs

    // Find which lead time bucket this milestone falls into
    for (const leadTimeMs of leadTimesMs) {
      if (timeUntilDue > 0 && timeUntilDue <= leadTimeMs) {
        // Check idempotency - ensure this milestone+leadTime hasn't been processed
        const milestoneKey = `milestone-in-digest-${vm.milestone_id}-${leadTimeMs}`

        // Skip if we've already seen this key in this run
        if (seenMilestoneKeys.has(milestoneKey)) break

        // Check if notification already exists
        const existingNotification = await db('notifications')
          .where('user_id', vm.user_id)
          .where('idempotency_key', milestoneKey)
          .first()

        if (existingNotification) break

        seenMilestoneKeys.add(milestoneKey)

        const item: MilestoneReminderItem = {
          vault_id: vm.vault_id,
          milestone_id: vm.milestone_id,
          milestone_title: vm.milestone_title,
          due_date: vm.due_date,
          lead_time_ms: leadTimeMs,
          lead_time_text: formatLeadTime(leadTimeMs),
        }

        if (!userReminders.has(vm.user_id)) {
          userReminders.set(vm.user_id, [])
        }
        userReminders.get(vm.user_id)!.push(item)

        // Break after first matching lead time to avoid multiple reminders
        break
      }
    }
  }

  // Phase 3: Fetch user preferences for all affected users
  const userIds = Array.from(userReminders.keys())
  const preferences = await getUserPreferencesBatch(userIds)

  // Phase 4: Process each user's reminders
  let digestsSent = 0
  let digestsDeferred = 0
  let totalMilestones = 0

  for (const [userId, items] of userReminders) {
    if (opts.limit && digestsSent + digestsDeferred >= opts.limit) break

    totalMilestones += items.length
    const prefs = preferences.get(userId)!

    // Generate digest idempotency key based on run timestamp (minute granularity)
    const runMinute = Math.floor(now.getTime() / 60000)
    const digestKey = `digest-reminders-${userId}-${runMinute}`

    // Create digest payload
    const digestPayload: DigestPayload = {
      user_id: userId,
      items,
      digest_idempotency_key: digestKey,
      run_timestamp: now.toISOString(),
    }

    // Check quiet-hours
    if (prefs.quiet_hours_enabled) {
      const quietConfig = {
        timezone: prefs.timezone,
        startTime: prefs.quiet_hours_start,
        endTime: prefs.quiet_hours_end,
      }

      if (isInQuietHours(now, quietConfig)) {
        // Defer the reminder
        const deliverAfter = getQuietHoursEndUTC(now, quietConfig)
        await storeDeferredReminder(userId, digestKey, digestPayload, deliverAfter)
        digestsDeferred++

        // Still mark individual milestones as processed to prevent double-counting
        for (const item of items) {
          const milestoneKey = `milestone-in-digest-${item.milestone_id}-${item.lead_time_ms}`
          await createNotification({
            user_id: userId,
            type: 'milestone_reminder_deferred',
            title: 'Reminder Deferred',
            message: `Reminder for "${item.milestone_title}" deferred until ${deliverAfter.toISOString()}`,
            data: {
              vaultId: item.vault_id,
              milestoneId: item.milestone_id,
              dueDate: item.due_date,
              leadTimeMs: item.lead_time_ms,
              deferredUntil: deliverAfter.toISOString(),
            },
            idempotency_key: milestoneKey,
          })
        }
        continue
      }
    }

    // Send digest notification immediately
    const title = renderDigestTitle(items)
    const message = renderDigestMessage({
      items,
      locale: 'en-US',
      timezone: prefs.timezone,
    })

    try {
      // Create individual idempotency records for each milestone
      for (const item of items) {
        const milestoneKey = `milestone-in-digest-${item.milestone_id}-${item.lead_time_ms}`
        await createNotification({
          user_id: userId,
          type: 'milestone_reminder_processed',
          title: `Processed: ${item.milestone_title}`,
          message: `Included in digest notification`,
          data: {
            vaultId: item.vault_id,
            milestoneId: item.milestone_id,
            dueDate: item.due_date,
            leadTimeMs: item.lead_time_ms,
            digestKey,
          },
          idempotency_key: milestoneKey,
        })
      }

      // Create the actual digest notification
      await createNotification({
        user_id: userId,
        type: 'milestone_digest',
        title,
        message,
        data: createDigestData(items),
        idempotency_key: digestKey,
      })

      digestsSent++
    } catch (err) {
      console.debug(`[milestone-digest] Error sending digest for user ${userId}`, err)
    }
  }

  return { digestsSent, digestsDeferred, totalMilestones }
}

/**
 * Processes deferred reminders that are due for delivery.
 * Called by the milestone.reminders.deferred job handler.
 */
export const processDeferredReminders = async (
  opts: { batchSize?: number } = {}
): Promise<number> => {
  const batchSize = opts.batchSize ?? 50
  const deferredReminders = await claimDueReminders(batchSize)

  let delivered = 0

  for (const deferred of deferredReminders) {
    const { reminder_data: payload, user_id: userId } = deferred
    const items = payload.items

    const title = renderDigestTitle(items)
    const message = renderDigestMessage({
      items,
      locale: 'en-US',
      timezone: 'UTC', // Could fetch user prefs again, but UTC is safe
    })

    try {
      await createNotification({
        user_id: userId,
        type: 'milestone_digest',
        title,
        message,
        data: createDigestData(items),
        idempotency_key: `${payload.digest_idempotency_key}-delivered`,
      })
      delivered++
    } catch (err) {
      console.debug(`[deferred-reminder] Error delivering deferred digest for user ${userId}`, err)
    }
  }

  return delivered
}
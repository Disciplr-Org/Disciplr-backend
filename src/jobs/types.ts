export const JOB_TYPES = [
  'notification.send',
  'deadline.check',
  'milestone.reminders',
  'milestone.reminders.digest',
  'milestone.reminders.deferred',
  'oracle.call',
  'analytics.recompute',
  'export.generate',
  'vault.reconcile',
  'sessions.cleanup',
  'outbox.relay',
  'embeddings.reindex',
  'saved-search.evaluate',
] as const

export type JobType = (typeof JOB_TYPES)[number]

export interface NotificationJobPayload {
  recipient: string
  subject: string
  body: string
}

export interface DeadlineCheckJobPayload {
  vaultId?: string
  deadlineIso?: string
  triggerSource: 'manual' | 'scheduler' | 'expiration-scheduler'
}

export interface MilestoneRemindersJobPayload {
  leadTimesMs?: number[]
  limit?: number
}

export interface MilestoneRemindersDigestJobPayload {
  leadTimesMs?: number[]
  limit?: number
}

export interface MilestoneRemindersDeferredJobPayload {
  batchSize?: number
}

export interface OracleCallJobPayload {
  oracle: string
  symbol: string
  requestId?: string
}

export interface AnalyticsRecomputeJobPayload {
  scope: 'global' | 'vault' | 'user'
  entityId?: string
  reason?: string
}

export interface ExportGenerateJobPayload {
  exportJobId: string
}

export interface VaultReconcileJobPayload {
  vaultIds?: string[]
  batchSize?: number
}

export interface SessionsCleanupJobPayload {
  batchSize?: number
}

export interface OutboxRelayJobPayload {
  batchSize?: number
}

export interface EmbeddingsReindexJobPayload {
  batchSize?: number
  maxBatchesPerRun?: number
}

export interface SavedSearchEvaluateJobPayload {
  searchId?: string
}

export interface JobPayloadByType {
  'notification.send': NotificationJobPayload
  'deadline.check': DeadlineCheckJobPayload
  'milestone.reminders': MilestoneRemindersJobPayload
  'milestone.reminders.digest': MilestoneRemindersDigestJobPayload
  'milestone.reminders.deferred': MilestoneRemindersDeferredJobPayload
  'oracle.call': OracleCallJobPayload
  'analytics.recompute': AnalyticsRecomputeJobPayload
  'export.generate': ExportGenerateJobPayload
  'vault.reconcile': VaultReconcileJobPayload
  'sessions.cleanup': SessionsCleanupJobPayload
  'outbox.relay': OutboxRelayJobPayload
  'embeddings.reindex': EmbeddingsReindexJobPayload
  'saved-search.evaluate': SavedSearchEvaluateJobPayload
}

export interface JobContext {
  jobId: string
  attempt: number
}

export type JobHandler<T extends JobType = JobType> = (
  payload: JobPayloadByType[T],
  context: JobContext,
) => Promise<void>

export interface EnqueueOptions {
  delayMs?: number
  maxAttempts?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0
}

const isOptionalString = (value: unknown): value is string | undefined => {
  return value === undefined || typeof value === 'string'
}

export const isJobType = (value: unknown): value is JobType => {
  if (typeof value !== 'string') {
    return false
  }

  return JOB_TYPES.includes(value as JobType)
}

export const isPayloadForJobType = (
  type: JobType,
  payload: unknown,
): payload is JobPayloadByType[JobType] => {
  if (!isRecord(payload)) {
    return false
  }

  switch (type) {
    case 'notification.send':
      return (
        isNonEmptyString(payload.recipient) &&
        isNonEmptyString(payload.subject) &&
        isNonEmptyString(payload.body)
      )
    case 'deadline.check':
      return (
        (payload.triggerSource === 'manual' || payload.triggerSource === 'scheduler' || payload.triggerSource === 'expiration-scheduler') &&
        isOptionalString(payload.vaultId) &&
        isOptionalString(payload.deadlineIso)
      )
    case 'milestone.reminders':
      return (
        (payload.leadTimesMs === undefined || Array.isArray(payload.leadTimesMs)) &&
        (payload.limit === undefined || typeof payload.limit === 'number')
      )
    case 'milestone.reminders.digest':
      return (
        (payload.leadTimesMs === undefined || Array.isArray(payload.leadTimesMs)) &&
        (payload.limit === undefined || typeof payload.limit === 'number')
      )
    case 'milestone.reminders.deferred':
      return payload.batchSize === undefined || (typeof payload.batchSize === 'number' && payload.batchSize > 0)
    case 'oracle.call':
      return (
        isNonEmptyString(payload.oracle) &&
        isNonEmptyString(payload.symbol) &&
        isOptionalString(payload.requestId)
      )
    case 'analytics.recompute':
      return (
        (payload.scope === 'global' || payload.scope === 'vault' || payload.scope === 'user') &&
        isOptionalString(payload.entityId) &&
        isOptionalString(payload.reason)
      )
    case 'export.generate':
      return isNonEmptyString(payload.exportJobId)
    case 'vault.reconcile':
      return (
        (payload.vaultIds === undefined || Array.isArray(payload.vaultIds)) &&
        (payload.batchSize === undefined || typeof payload.batchSize === 'number')
      )
    case 'sessions.cleanup':
      return payload.batchSize === undefined || (typeof payload.batchSize === 'number' && payload.batchSize > 0)
    case 'outbox.relay':
      return true
    case 'embeddings.reindex':
      return (
        (payload.batchSize === undefined || (typeof payload.batchSize === 'number' && payload.batchSize > 0)) &&
        (payload.maxBatchesPerRun === undefined ||
          (typeof payload.maxBatchesPerRun === 'number' && payload.maxBatchesPerRun > 0))
      )
    case 'saved-search.evaluate':
      return payload.searchId === undefined || typeof payload.searchId === 'string'
    default:
      return false
  }
}

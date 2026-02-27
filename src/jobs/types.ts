export const JOB_TYPES = [
  'notification.send',
  'deadline.check',
  'oracle.call',
  'analytics.recompute',
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
  triggerSource: 'manual' | 'scheduler'
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

export interface JobPayloadByType {
  'notification.send': NotificationJobPayload
  'deadline.check': DeadlineCheckJobPayload
  'oracle.call': OracleCallJobPayload
  'analytics.recompute': AnalyticsRecomputeJobPayload
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
        (payload.triggerSource === 'manual' || payload.triggerSource === 'scheduler') &&
        isOptionalString(payload.vaultId) &&
        isOptionalString(payload.deadlineIso)
      )
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
    default:
      return false
  }
}

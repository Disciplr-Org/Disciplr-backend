import { z, ZodError } from 'zod'
import { UserRole } from '../types/user.js'
import { hasTimezoneDesignator, isValidISO8601, parseAndNormalizeToUTC } from '../utils/timestamps.js'
 
export function formatIssuePath(path: Array<string | number | symbol>): string {
  if (!Array.isArray(path) || path.length === 0) return 'root'

  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'string') {
      return acc ? `${acc}.${segment}` : segment
    }

    if (typeof segment === 'number') {
      return `${acc}[${segment}]`
    }

    return acc
  }, '') || 'root'
}

export function flattenZodErrors(error: ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
    code: issue.code,
  }))
}

export function buildValidationError(fields: Array<{ path: string; message: string; code: string }>) {
  return {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request payload',
      fields,
    },
  }
}

export function formatValidationError(error: ZodError) {
  return buildValidationError(flattenZodErrors(error))
}

export const utcTimestampSchema = z
  .string({ message: 'required' })
  .refine(
    (value) => hasTimezoneDesignator(value),
    'must include timezone (Z or +/-HH:MM)',
  )
  .refine(
    (value) => isValidISO8601(value),
    'must be a valid ISO 8601 timestamp',
  )
  .transform((value) => parseAndNormalizeToUTC(value))

export const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    role: z.nativeEnum(UserRole).optional(),
})

export const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
})

export const refreshSchema = z.object({
    refreshToken: z.string(),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type RefreshInput = z.infer<typeof refreshSchema>


export const nonEmptyString = z.string().trim().min(1)

export const notificationPayloadSchema = z.object({
  recipient: nonEmptyString,
  subject: nonEmptyString,
  body: nonEmptyString,
})

export const deadlineCheckPayloadSchema = z.object({
  triggerSource: z.enum(['manual', 'scheduler']),
  vaultId: z.string().optional(),
  deadlineIso: z.string().optional(),
})

export const oracleCallPayloadSchema = z.object({
  oracle: nonEmptyString,
  symbol: nonEmptyString,
  requestId: z.string().optional(),
})

export const analyticsRecomputePayloadSchema = z.object({
  scope: z.enum(['global', 'vault', 'user']),
  entityId: z.string().optional(),
  reason: z.string().optional(),
})

export const enqueueJobSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('notification.send'),
    payload: notificationPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('deadline.check'),
    payload: deadlineCheckPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('oracle.call'),
    payload: oracleCallPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('analytics.recompute'),
    payload: analyticsRecomputePayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
])

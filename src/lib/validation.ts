import { z, ZodError } from 'zod'
import { UserRole } from '../types/user.js'
import { hasTimezoneDesignator, isValidISO8601, parseAndNormalizeToUTC } from '../utils/timestamps.js'


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

export const utcTimestampSchema = z
  .string({ error: 'required' })
  .superRefine((value, ctx) => {
    if (!hasTimezoneDesignator(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must include timezone (Z or +/-HH:MM)',
      })
      return
    }

    if (!isValidISO8601(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a valid ISO 8601 timestamp',
      })
    }
  })
  .transform((value, ctx) => {
    if (!isValidISO8601(value)) {
      return z.NEVER
    }

    try {
      return parseAndNormalizeToUTC(value)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid ISO 8601 timestamp',
      })
      return z.NEVER
    }
  })



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

export interface ValidationErrorField {
  path: string
  message: string
  code: string
}

export const formatIssuePath = (path: ReadonlyArray<PropertyKey>): string =>
  path
    .filter((seg): seg is string | number => typeof seg === 'string' || typeof seg === 'number')
    .reduce<string>((acc, seg, i) => {
      if (typeof seg === 'number') return `${acc}[${seg}]`
      return i === 0 ? seg : `${acc}.${seg}`
    }, '')

export const flattenZodErrors = (error: z.ZodError): ValidationErrorField[] =>
  error.issues.map((issue) => ({
    path: formatIssuePath(issue.path) || 'root',
    message: issue.message,
    code: issue.code,
  }))

export const buildValidationError = (fields: ValidationErrorField[]) => ({
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Invalid request payload',
    fields,
  },
})

export const formatValidationError = (error: z.ZodError) => buildValidationError(flattenZodErrors(error))


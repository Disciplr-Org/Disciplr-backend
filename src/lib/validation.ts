import { z } from 'zod'
import { UserRole } from '../types/user.js'

// ---------------------------------------------------------------------------
// Validation error helpers
// ---------------------------------------------------------------------------

export interface FieldError {
  path: string
  message: string
  code: string
}

export interface ValidationErrorEnvelope {
  error: {
    code: 'VALIDATION_ERROR'
    message: string
    fields: FieldError[]
  }
}

/**
 * Format a ZodIssue path array into a dot/bracket-notation string.
 * e.g. ['milestones', 1, 'dueDate'] → 'milestones[1].dueDate'
 */
export const formatIssuePath = (path: (string | number | symbol)[]): string => {
  return path
    .filter((segment) => typeof segment === 'string' || typeof segment === 'number')
    .map((segment, index) => {
      if (typeof segment === 'number') {
        return `[${segment}]`
      }
      return index === 0 ? segment : `.${segment}`
    })
    .join('')
    || 'root'
}

/**
 * Flatten Zod validation issues into client-friendly FieldError records.
 */
export const flattenZodErrors = (error: z.ZodError): FieldError[] => {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? formatIssuePath(issue.path) : 'root',
    message: issue.message,
    code: issue.code === 'invalid_type'
      ? 'invalid_type'
      : issue.code === 'too_small'
        ? 'too_small'
        : issue.code === 'too_big'
          ? 'too_big'
          : issue.code === 'invalid_string'
            ? 'invalid_format'
            : issue.code === 'custom'
              ? 'custom'
              : issue.code,
  }))
}

/**
 * Wrap an array of FieldError into the standard error envelope.
 */
export const buildValidationError = (fields: FieldError[]): ValidationErrorEnvelope => ({
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Invalid request payload',
    fields,
  },
})

/**
 * Convert a ZodError directly to the standard validation error envelope.
 */
export const formatValidationError = (error: z.ZodError): ValidationErrorEnvelope =>
  buildValidationError(flattenZodErrors(error))

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

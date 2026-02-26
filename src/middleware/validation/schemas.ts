import { z } from 'zod'

export const createApiKeySchema = z.object({
  label: z.string()
    .min(1, 'Label is required')
    .max(100, 'Label must be 100 characters or less')
    .trim(),
  scopes: z.array(z.string().trim())
    .min(1, 'At least one scope is required')
    .max(10, 'Maximum 10 scopes allowed'),
  orgId: z.string()
    .max(50, 'Organization ID must be 50 characters or less')
    .trim()
    .optional()
})

export const revokeApiKeySchema = z.object({
  id: z.string()
    .min(1, 'API Key ID is required')
    .uuid('Invalid API Key ID format')
})

export const sendTestEmailSchema = z.object({
  to: z.string()
    .email('Invalid email address')
    .max(255, 'Email address too long'),
  eventType: z.string()
    .max(50, 'Event type must be 50 characters or less')
    .optional(),
  data: z.record(z.unknown())
    .optional()
})

export const sendVaultCreatedEmailSchema = z.object({
  vault: z.object({
    id: z.string().min(1, 'Vault ID is required'),
    creator: z.string().min(1, 'Creator is required'),
    amount: z.string().min(1, 'Amount is required'),
    endTimestamp: z.string().min(1, 'End timestamp is required'),
    successDestination: z.string().min(1, 'Success destination is required'),
    failureDestination: z.string().min(1, 'Failure destination is required')
  }),
  recipientEmail: z.string()
    .email('Invalid recipient email address')
    .max(255, 'Email address too long')
})

export const sendDeadlineApproachingEmailSchema = z.object({
  vault: z.object({
    id: z.string().min(1, 'Vault ID is required'),
    creator: z.string().min(1, 'Creator is required'),
    amount: z.string().min(1, 'Amount is required'),
    endTimestamp: z.string().min(1, 'End timestamp is required'),
    successDestination: z.string().min(1, 'Success destination is required'),
    failureDestination: z.string().min(1, 'Failure destination is required')
  }),
  recipientEmail: z.string()
    .email('Invalid recipient email address')
    .max(255, 'Email address too long'),
  timeRemaining: z.string().min(1, 'Time remaining is required')
})

export const createVaultSchema = z.object({
  creator: z.string()
    .min(1, 'Creator is required')
    .max(100, 'Creator must be 100 characters or less')
    .trim(),
  amount: z.string()
    .min(1, 'Amount is required')
    .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a valid decimal number'),
  endTimestamp: z.string()
    .min(1, 'End timestamp is required')
    .datetime('Invalid datetime format'),
  successDestination: z.string()
    .min(1, 'Success destination is required')
    .max(255, 'Success destination must be 255 characters or less')
    .trim(),
  failureDestination: z.string()
    .min(1, 'Failure destination is required')
    .max(255, 'Failure destination must be 255 characters or less')
    .trim()
})

export const getVaultByIdSchema = z.object({
  id: z.string()
    .min(1, 'Vault ID is required')
    .regex(/^vault-\d+-[a-z0-9]+$/, 'Invalid vault ID format')
})

export const getTransactionByIdSchema = z.object({
  id: z.string()
    .min(1, 'Transaction ID is required')
    .regex(/^[a-zA-Z0-9-]+$/, 'Invalid transaction ID format')
})

export const privacyExportSchema = z.object({
  creator: z.string()
    .min(1, 'Creator is required')
    .max(100, 'Creator must be 100 characters or less')
    .trim()
})

export const privacyDeleteAccountSchema = z.object({
  creator: z.string()
    .min(1, 'Creator is required')
    .max(100, 'Creator must be 100 characters or less')
    .trim()
})

export const analyticsQuerySchema = z.object({
  vaultId: z.string().optional(),
  metric: z.string().optional(),
  period: z.enum(['daily', 'weekly', 'monthly']).optional(),
  page: z.string().regex(/^\d+$/, 'Page must be a number').optional(),
  limit: z.string().regex(/^\d+$/, 'Limit must be a number').optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional()
})

export const transactionsQuerySchema = z.object({
  vaultId: z.string().optional(),
  type: z.enum(['deposit', 'withdrawal', 'milestone']).optional(),
  status: z.enum(['pending', 'completed', 'failed']).optional(),
  page: z.string().regex(/^\d+$/, 'Page must be a number').optional(),
  limit: z.string().regex(/^\d+$/, 'Limit must be a number').optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional()
})

export const vaultsQuerySchema = z.object({
  status: z.enum(['active', 'completed', 'failed', 'cancelled']).optional(),
  creator: z.string().optional(),
  page: z.string().regex(/^\d+$/, 'Page must be a number').optional(),
  limit: z.string().regex(/^\d+$/, 'Limit must be a number').optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional()
})

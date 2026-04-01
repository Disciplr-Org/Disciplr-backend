import { z } from 'zod'

// ─── Soroban-aligned constants ───────────────────────────────────────────────

/** Minimum vault / milestone amount (inclusive). Maps to contract lower-bound. */
export const VAULT_AMOUNT_MIN = 1

/** Maximum vault / milestone amount (inclusive). Maps to i128 practical upper-bound. */
export const VAULT_AMOUNT_MAX = 1_000_000_000

/** Stellar strkey G-address: 'G' + 55 base-32 chars (A-Z, 2-7). */
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/

// ─── Reusable field schemas ──────────────────────────────────────────────────

// Zod v4 uses { error: '...' } instead of { required_error: '...' }
const stellarAddressSchema = z
  .string({ error: 'required' })
  .regex(STELLAR_ADDRESS_RE, 'must be a valid Stellar public key')

/**
 * Amount field: stored as a string, but the value must parse to a finite
 * positive number within the Soroban contract bounds.
 * Accepts both numeric strings ("1000") and JS numbers (1000) via preprocess.
 */
const amountStringSchema = z.preprocess(
  (val) => (typeof val === 'number' ? String(val) : val),
  z
    .string({ error: 'required' })
    .refine(
      (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 },
      'must be a positive number',
    )
    .refine(
      (v) => { const n = Number(v); return n >= VAULT_AMOUNT_MIN && n <= VAULT_AMOUNT_MAX },
      `must be between ${VAULT_AMOUNT_MIN} and ${VAULT_AMOUNT_MAX.toLocaleString()}`,
    ),
)

const isoTimestampSchema = z
  .string({ error: 'required' })
  .refine((v) => !isNaN(Date.parse(v)), 'must be a valid ISO timestamp')

// ─── Milestone schema ────────────────────────────────────────────────────────

const milestoneSchema = z.object({
  title: z
    .string({ error: 'is required' })
    .refine((v) => v.trim().length > 0, 'is required'),
  description: z.string().optional(),
  dueDate: isoTimestampSchema,
  amount: amountStringSchema,
})

// ─── Root vault schema ───────────────────────────────────────────────────────

export const createVaultSchema = z
  .object({
    amount: amountStringSchema,
    startDate: isoTimestampSchema,
    endDate: isoTimestampSchema,
    verifier: stellarAddressSchema,
    destinations: z.object({
      success: stellarAddressSchema,
      failure: stellarAddressSchema,
    }),
    milestones: z
      .array(milestoneSchema)
      .min(1, 'must contain at least one item'),
    creator: stellarAddressSchema.optional(),
    onChain: z
      .object({
        mode: z.enum(['build', 'submit']).optional().default('build'),
        contractId: z.string().optional(),
        networkPassphrase: z.string().optional(),
        sourceAccount: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    const startMs = Date.parse(data.startDate)
    const endMs = Date.parse(data.endDate)

    // endDate must be strictly after startDate
    if (!isNaN(startMs) && !isNaN(endMs) && endMs <= startMs) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be greater than startDate',
        path: ['endDate'],
      })
    }

    // Each milestone dueDate must be >= startDate
    if (!isNaN(startMs)) {
      data.milestones.forEach((milestone, i) => {
        const dueMs = Date.parse(milestone.dueDate)
        if (!isNaN(dueMs) && dueMs < startMs) {
          ctx.addIssue({
            code: 'custom',
            message: 'cannot be before startDate',
            path: ['milestones', i, 'dueDate'],
          })
        }
      })
    }

    // Total milestone amounts must not exceed vault amount
    const vaultAmount = Number(data.amount)
    if (Number.isFinite(vaultAmount)) {
      const total = data.milestones.reduce((acc, m) => acc + Number(m.amount), 0)
      if (total > vaultAmount) {
        ctx.addIssue({
          code: 'custom',
          message: 'Total milestone amount cannot exceed vault amount',
          path: ['milestones'],
        })
      }
    }
  })

export type ParsedCreateVaultInput = z.infer<typeof createVaultSchema>

// ─── Error helpers ───────────────────────────────────────────────────────────

const formatIssuePath = (path: ReadonlyArray<PropertyKey>): string =>
  path
    .filter((seg): seg is string | number => typeof seg === 'string' || typeof seg === 'number')
    .reduce<string>((acc, seg, i) => {
      if (typeof seg === 'number') return `${acc}[${seg}]`
      return i === 0 ? seg : `${acc}.${seg}`
    }, '')

/**
 * Flatten a ZodError into a string array that matches the existing error
 * format, e.g. "amount must be a positive number",
 * "milestones[0].dueDate must be a valid ISO timestamp".
 */
export const flattenZodErrors = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const prefix = formatIssuePath(issue.path)
    return prefix ? `${prefix} ${issue.message}` : issue.message
  })

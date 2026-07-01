import { z } from 'zod'
import { utcTimestampSchema } from '../lib/validation.js'
import { StrKey } from '@stellar/stellar-sdk'
export { flattenZodErrors } from '../lib/validation.js'

// ─── Soroban-aligned constants ───────────────────────────────────────────────

/** Minimum vault / milestone amount (inclusive). Maps to contract lower-bound. */
export const VAULT_AMOUNT_MIN = 1

/** Maximum vault / milestone amount (inclusive). Maps to i128 practical upper-bound. */
export const VAULT_AMOUNT_MAX = 1_000_000_000

/** Minimum number of milestones in a vault. */
export const VAULT_MILESTONES_MIN = 1

/** Maximum number of milestones in a vault. This caps request size and enforces operational limits. */
export const VAULT_MILESTONES_MAX = 20

// Mock exchange addresses requiring a memo.
// GDHWBXJFCTBJ6ZQPK2E64JAOMHQOEOMWQ43Q5C3J6TEA6SNOFELWBVCY (Valid Classic 1) is the primary mock exchange for testing.
export const MEMO_REQUIRED_EXCHANGES = new Set([
  'GDHWBXJFCTBJ6ZQPK2E64JAOMHQOEOMWQ43Q5C3J6TEA6SNOFELWBVCY',
])

export function getClassicAddress(address: string): string {
  try {
    if (StrKey.isValidMed25519PublicKey(address)) {
      const decoded = StrKey.decodeMed25519PublicKey(address)
      return StrKey.encodeEd25519PublicKey(decoded.slice(0, 32))
    }
  } catch {
    // ignore
  }
  return address
}

export function isUnsafeAddress(address: string): boolean {
  try {
    let pubkey: Buffer
    if (StrKey.isValidEd25519PublicKey(address)) {
      pubkey = StrKey.decodeEd25519PublicKey(address)
    } else if (StrKey.isValidMed25519PublicKey(address)) {
      pubkey = StrKey.decodeMed25519PublicKey(address).slice(0, 32)
    } else {
      return false
    }
    const allZeros = pubkey.every((b) => b === 0x00)
    const allOnes = pubkey.every((b) => b === 0xff)
    return allZeros || allOnes
  } catch {
    return true
  }
}

// ─── Reusable field schemas ──────────────────────────────────────────────────

const stellarAddressSchema = z
  .string({ message: 'required' })
  .superRefine((val, ctx) => {
    if (val.startsWith('C')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Contract addresses are not allowed where an account is required',
      })
      return
    }
    try {
      const isValid = StrKey.isValidEd25519PublicKey(val) || StrKey.isValidMed25519PublicKey(val)
      if (!isValid) {
        ctx.addIssue({
          code: 'custom',
          message: 'must be a valid Stellar public key',
        })
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a valid Stellar public key',
      })
    }
  })

/**
 * Amount field: stored as a string, but the value must parse to a finite
 * positive number within the Soroban contract bounds.
 * Accepts both numeric strings ("1000") and JS numbers (1000) via preprocess.
 */
const amountStringSchema = z.preprocess(
  (val) => (typeof val === 'number' ? String(val) : val),
  z
    .string({ message: 'required' })
    .refine(
      (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 },
      'must be a positive number',
    )
    .refine(
      (v) => { const n = Number(v); return n >= VAULT_AMOUNT_MIN && n <= VAULT_AMOUNT_MAX },
      `must be between ${VAULT_AMOUNT_MIN} and ${VAULT_AMOUNT_MAX.toLocaleString()}`,
    ),
)

// ─── Milestone schema ────────────────────────────────────────────────────────

const milestoneSchema = z.object({
  title: z
    .string({ message: 'is required' })
    .refine((v) => v.trim().length > 0, 'is required'),
  description: z.string().optional(),
  dueDate: utcTimestampSchema,
  amount: amountStringSchema,
})

// ─── Root vault schema ───────────────────────────────────────────────────────

export const createVaultSchema = z
  .object({
    amount: amountStringSchema,
    startDate: utcTimestampSchema,
    endDate: utcTimestampSchema,
    verifier: stellarAddressSchema,
    destinations: z.object({
      success: stellarAddressSchema,
      failure: stellarAddressSchema,
    }),
    milestones: z
      .array(milestoneSchema)
      .min(VAULT_MILESTONES_MIN, 'must contain at least one item')
      .max(VAULT_MILESTONES_MAX, `must contain at most ${VAULT_MILESTONES_MAX} items`),
    creator: stellarAddressSchema.optional(),
    orgId: z.string().uuid().optional(),
    organizationId: z.string().uuid().optional(),
    /**
     * Grace window in seconds after a milestone dueDate during which check-in
     * is still accepted. Must be a non-negative integer. Bounded at runtime by
     * vault endDate. Defaults to 0 (no grace period).
     */
    lateCheckInWindowSecs: z
      .number()
      .int('must be an integer')
      .min(0, 'must be non-negative')
      .optional()
      .default(0),
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

    // Reject unsafe success/failure destination addresses
    if (isUnsafeAddress(data.destinations.success)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Destination address cannot be a zero, burn, or unsafe address',
        path: ['destinations', 'success'],
      })
    }
    if (isUnsafeAddress(data.destinations.failure)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Destination address cannot be a zero, burn, or unsafe address',
        path: ['destinations', 'failure'],
      })
    }

    // Reject exchange destinations lacking a memo
    const successClassic = getClassicAddress(data.destinations.success)
    if (MEMO_REQUIRED_EXCHANGES.has(successClassic)) {
      if (!StrKey.isValidMed25519PublicKey(data.destinations.success)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Destination is a known exchange that requires a memo. Use a muxed address.',
          path: ['destinations', 'success'],
        })
      }
    }
    const failureClassic = getClassicAddress(data.destinations.failure)
    if (MEMO_REQUIRED_EXCHANGES.has(failureClassic)) {
      if (!StrKey.isValidMed25519PublicKey(data.destinations.failure)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Destination is a known exchange that requires a memo. Use a muxed address.',
          path: ['destinations', 'failure'],
        })
      }
    }

    // Validate embedded muxed address memo ID range
    if (StrKey.isValidMed25519PublicKey(data.destinations.success)) {
      try {
        const decoded = StrKey.decodeMed25519PublicKey(data.destinations.success)
        const memoId = decoded.readBigUInt64BE(32)
        if (memoId < 0n) {
          ctx.addIssue({
            code: 'custom',
            message: 'Invalid memo ID in success destination',
            path: ['destinations', 'success'],
          })
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid or malformed muxed address for success destination',
          path: ['destinations', 'success'],
        })
      }
    }
    if (StrKey.isValidMed25519PublicKey(data.destinations.failure)) {
      try {
        const decoded = StrKey.decodeMed25519PublicKey(data.destinations.failure)
        const memoId = decoded.readBigUInt64BE(32)
        if (memoId < 0n) {
          ctx.addIssue({
            code: 'custom',
            message: 'Invalid memo ID in failure destination',
            path: ['destinations', 'failure'],
          })
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid or malformed muxed address for failure destination',
          path: ['destinations', 'failure'],
        })
      }
    }
  })

export type ParsedCreateVaultInput = z.infer<typeof createVaultSchema>

/**
 * Lazy-check whether a string is a valid Stellar ed25519 public key (G... address).
 * Uses `@stellar/stellar-sdk` StrKey.isValidEd25519PublicKey but imports the
 * library dynamically so cold-start cost is minimised.
 */
export async function isValidStellarAddress(address: string): Promise<boolean> {
  if (typeof address !== 'string') return false
  // Quick regex check first to avoid importing the SDK for obvious failures
  if (!STELLAR_ADDRESS_RE.test(address)) return false

  try {
    const mod = await import('@stellar/stellar-sdk')
    // StrKey.isValidEd25519PublicKey is the canonical checksum+format check
    return Boolean(mod?.StrKey?.isValidEd25519PublicKey?.(address))
  } catch (err) {
    // If the import fails for any reason, conservatively treat as invalid.
    return false
  }
}

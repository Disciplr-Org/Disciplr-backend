import { z } from 'zod'
import { utcTimestampSchema } from '../lib/validation.js'
import { Horizon, StrKey } from '@stellar/stellar-sdk'
export { flattenZodErrors } from '../lib/validation.js'

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/

/** Soroban contract addresses (C...) use the same strkey alphabet as G... accounts. */
const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/

/**
 * Network passphrase this backend is configured to build payloads for.
 * Mirrors the default in `src/services/soroban.ts`; the route rejects
 * client-supplied passphrases that differ so a vault payload can never be
 * built for the wrong network.
 */
export const DEFAULT_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'

export function getConfiguredNetworkPassphrase(): string {
  return process.env.SOROBAN_NETWORK_PASSPHRASE ?? DEFAULT_NETWORK_PASSPHRASE
}

/** Lazy format check for Soroban contract addresses (C..., 56 chars). */
export function isValidContractAddress(value: string): boolean {
  return typeof value === 'string' && CONTRACT_ADDRESS_RE.test(value)
}

// ─── Soroban-aligned constants ───────────────────────────────────────────────

/** Minimum vault / milestone amount (inclusive). Maps to contract lower-bound. */
export const VAULT_AMOUNT_MIN = 1

/** Maximum vault / milestone amount (inclusive). Maps to i128 practical upper-bound. */
export const VAULT_AMOUNT_MAX = 1_000_000_000

/** Minimum number of milestones in a vault. */
export const VAULT_MILESTONES_MIN = 1

/** Maximum number of milestones in a vault. This caps request size and enforces operational limits. */
export const VAULT_MILESTONES_MAX = 20

export function getClassicAddress(address: string): string {
  if (address.startsWith('M')) {
    try {
      const decoded = StrKey.decodeMed25519PublicKey(address)
      return StrKey.encodeEd25519PublicKey(decoded.slice(0, 32))
    } catch {
      throw new Error(`Invalid muxed address format`);
    }
  }
  return address
}

/**
 * Result of checking whether an address is unsafe or has decode errors.
 * - isBurnAddress: true if the address is all-zero or all-ones (burn address)
 * - decodeError: true if the SDK failed to decode for reasons other than validation
 */
export interface UnsafeAddressResult {
  isBurnAddress: boolean
  decodeError: boolean
}

/**
 * Checks if an address is a burn address (all-zero or all-ones bytes).
 * Returns an object distinguishing between genuine burn addresses and decode failures.
 */
export function checkAddressSafety(address: string): UnsafeAddressResult {
  // First, validate the address format
  const isValidEd = StrKey.isValidEd25519PublicKey(address)
  const isValidMed = StrKey.isValidMed25519PublicKey(address)
  
  if (!isValidEd && !isValidMed) {
    // Not a valid format, but this is not a decode error - just invalid
    return { isBurnAddress: false, decodeError: false }
  }

  try {
    let pubkey: Buffer
    if (isValidEd) {
      pubkey = StrKey.decodeEd25519PublicKey(address)
    } else {
      pubkey = StrKey.decodeMed25519PublicKey(address).slice(0, 32)
    }
    
    const allZeros = pubkey.every((b) => b === 0x00)
    const allOnes = pubkey.every((b) => b === 0xff)
    
    return {
      isBurnAddress: allZeros || allOnes,
      decodeError: false
    }
  } catch (error) {
    // An unexpected decode error occurred despite validation passing
    return {
      isBurnAddress: false,
      decodeError: true
    }
  }
}

/**
 * Legacy function for backward compatibility.
 * Returns true if the address is unsafe (burn address OR decode error).
 * @deprecated Use checkAddressSafety() for more granular error handling
 */
export function isUnsafeAddress(address: string): boolean {
  const result = checkAddressSafety(address)
  return result.isBurnAddress || result.decodeError
}

// Checks SEP-29: returns true if the account has set config.memo_required=1
export async function isMemoRequired(address: string, horizonUrl?: string): Promise<boolean> {
  const classic = getClassicAddress(address)
  if (!StrKey.isValidEd25519PublicKey(classic)) return false
  try {
    const server = new Horizon.Server(horizonUrl ?? process.env.HORIZON_URL ?? 'https://horizon.stellar.org')
    const account = await server.loadAccount(classic)
    return account.data_attr?.['config.memo_required'] === 'MQ=='  // base64("1")
  } catch {
    return false
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
      (v) => /^\d+(?:\.\d{1,7})?$/.test(v),
      'must be a decimal amount with at most 7 fractional digits',
    )
    .refine(
      (v) => { const n = Number(v); return n >= VAULT_AMOUNT_MIN && n <= VAULT_AMOUNT_MAX },
      `must be between ${VAULT_AMOUNT_MIN} and ${VAULT_AMOUNT_MAX.toLocaleString()}`,
    ),
)

const AMOUNT_SCALE = 10_000_000n
const DECIMAL_AMOUNT_RE = /^\d+(?:\.\d{1,7})?$/

/** Convert an already grammar-validated decimal into exact seven-place units. */
function amountToUnits(value: string): bigint | null {
  if (!DECIMAL_AMOUNT_RE.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * AMOUNT_SCALE + BigInt(fraction.padEnd(7, '0'))
}

// ─── Milestone schema ────────────────────────────────────────────────────────

/** Maximum length for milestone title. */
export const MILESTONE_TITLE_MAX = 200

/** Maximum length for milestone description. */
export const MILESTONE_DESCRIPTION_MAX = 2000

/**
 * Canonical milestone field schema shared between vault-creation and the
 * standalone milestone-creation endpoint.  Both code paths must produce
 * milestones that satisfy the same invariants.
 */
export const milestoneSchema = z.object({
  title: z
    .string({ message: 'is required' })
    .refine((v) => v.trim().length > 0, 'is required')
    .refine((v) => v.trim().length <= MILESTONE_TITLE_MAX, `must be at most ${MILESTONE_TITLE_MAX} characters`),
  description: z
    .string()
    .max(MILESTONE_DESCRIPTION_MAX, `must be at most ${MILESTONE_DESCRIPTION_MAX} characters`)
    .optional(),
  dueDate: utcTimestampSchema,
  amount: amountStringSchema,
})

/** Single entry point for standalone milestone creation validation. */
export function parseMilestoneInput(input: unknown) {
  return milestoneSchema.safeParse(input)
}

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
        contractId: z
          .string()
          .refine(isValidContractAddress, 'must be a valid Stellar contract address (C...)')
          .optional(),
        networkPassphrase: z
          .string()
          .refine(
            (val) => val === getConfiguredNetworkPassphrase(),
            'does not match the configured network passphrase',
          )
          .optional(),
        sourceAccount: z
          .string()
          .refine(
            (val) => StrKey.isValidEd25519PublicKey(val) || StrKey.isValidMed25519PublicKey(val),
            'must be a valid Stellar account address (G... or M...)',
          )
          .optional(),
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

    // Compare scaled decimal units exactly; Number summation can drift at the
    // seventh decimal place and reject a schedule that exactly fits.
    const vaultAmountUnits = amountToUnits(data.amount)
    const milestoneUnits = data.milestones.map((milestone) => amountToUnits(milestone.amount))
    if (vaultAmountUnits !== null && milestoneUnits.every((units): units is bigint => units !== null)) {
      const total = milestoneUnits.reduce((acc, units) => acc + units, 0n)
      if (total > vaultAmountUnits) {
        ctx.addIssue({
          code: 'custom',
          message: 'Total milestone amount cannot exceed vault amount',
          path: ['milestones'],
        })
      }
    }

    // Reject unsafe success/failure destination addresses with specific error messages
    const successSafety = checkAddressSafety(data.destinations.success)
    if (successSafety.isBurnAddress) {
      ctx.addIssue({
        code: 'custom',
        message: 'Destination address cannot be a zero or burn address (all-zero or all-ones bytes)',
        path: ['destinations', 'success'],
      })
    } else if (successSafety.decodeError) {
      ctx.addIssue({
        code: 'custom',
        message: 'Failed to decode destination address - unexpected SDK error',
        path: ['destinations', 'success'],
      })
    }
    
    const failureSafety = checkAddressSafety(data.destinations.failure)
    if (failureSafety.isBurnAddress) {
      ctx.addIssue({
        code: 'custom',
        message: 'Destination address cannot be a zero or burn address (all-zero or all-ones bytes)',
        path: ['destinations', 'failure'],
      })
    } else if (failureSafety.decodeError) {
      ctx.addIssue({
        code: 'custom',
        message: 'Failed to decode destination address - unexpected SDK error',
        path: ['destinations', 'failure'],
      })
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

/**
 * Guards the server-generated vault-creation response before it is sent to a
 * client (or replayed from an idempotency reservation).
 *
 * The replayed response is parsed from a stored JSON row, so a corrupt or
 * truncated reservation must never be forwarded as if it were a valid vault.
 * Throws on malformed shapes; callers map the failure to a generic 500 so no
 * internals leak to the client.
 */
export function assertValidVaultCreateResponse(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new Error('vault create response must be an object')
  }
  const body = value as Record<string, unknown>

  const vault = body.vault
  if (vault === null || typeof vault !== 'object') {
    throw new Error('vault create response is missing the vault object')
  }
  const vaultId = (vault as Record<string, unknown>).id
  if (typeof vaultId !== 'string' || vaultId.length === 0) {
    throw new Error('vault create response is missing a vault id')
  }

  const onChain = body.onChain
  if (onChain === null || typeof onChain !== 'object') {
    throw new Error('vault create response is missing the onChain payload')
  }
  const payload = (onChain as Record<string, unknown>).payload
  if (
    payload === null ||
    typeof payload !== 'object' ||
    (payload as Record<string, unknown>).method !== 'create_vault'
  ) {
    throw new Error('vault create response onChain payload is malformed')
  }
}

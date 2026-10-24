import { z } from 'zod'
import { StrKey } from '@stellar/stellar-sdk'

// 5 years in milliseconds: 5 * 365 * 24 * 60 * 60 * 1000 = 157,680,000,000 ms
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000
// 5 minutes in milliseconds for clock skew allowance
const FIVE_MINUTES_MS = 5 * 60 * 1000
const MAX_TITLE_BYTES = 128

/**
 * Parses date input into a Date object treating string inputs without timezone as UTC.
 * Returns null if invalid or unparseable.
 */
export function parseDateAsUtc(value) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null

  // Date-only YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00.000Z')
    return isNaN(d.getTime()) ? null : d
  }
  // Date-time with timezone offset (Z, +HH:MM, -HH:MM)
  if (/Z|[+-]\d{2}:?\d{2}$/i.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }
  // Date-time without timezone: treat as UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/i.test(s)) {
    const d = new Date(s + 'Z')
    return isNaN(d.getTime()) ? null : d
  }

  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/**
 * Validates a Stellar G-address (Ed25519 public key) checking format and CRC16 checksum.
 * Specifically rejects Muxed addresses (M...) with an explicit message.
 */
function validateStellarAddress(val, ctx, fieldName) {
  if (typeof val !== 'string' || !val) {
    ctx.addIssue({
      code: 'custom',
      message: `${fieldName} is required`,
      path: [fieldName],
    })
    return
  }

  if (val.startsWith('M')) {
    ctx.addIssue({
      code: 'invalid_address',
      message: `${fieldName} must be a Stellar G-address (muxed M-addresses are not supported)`,
      path: [fieldName],
    })
    return
  }

  if (!StrKey.isValidEd25519PublicKey(val)) {
    ctx.addIssue({
      code: 'invalid_address',
      message: `${fieldName} must be a valid Stellar public key (G..., 56 characters with valid checksum)`,
      path: [fieldName],
    })
  }
}

function validateOptionalStellarAddress(val, ctx, fieldName) {
  if (val === undefined || val === null || val === '') return

  if (typeof val !== 'string') {
    ctx.addIssue({
      code: 'invalid_address',
      message: `${fieldName} must be a valid Stellar public key`,
      path: [fieldName],
    })
    return
  }

  if (val.startsWith('M')) {
    ctx.addIssue({
      code: 'invalid_address',
      message: `${fieldName} must be a Stellar G-address (muxed M-addresses are not supported)`,
      path: [fieldName],
    })
    return
  }

  if (!StrKey.isValidEd25519PublicKey(val)) {
    ctx.addIssue({
      code: 'invalid_address',
      message: `${fieldName} must be a valid Stellar public key (G..., 56 characters with valid checksum)`,
      path: [fieldName],
    })
  }
}

export const createMilestoneSchema = z.object({
  title: z.unknown(),
  amount: z.unknown(),
  dueDate: z.unknown().optional(),
}).strict()

export const createVaultSchema = z.object({
  name: z.unknown().optional(),
  creator: z.unknown(),
  verifier: z.unknown(),
  amount: z.unknown(),
  startDate: z.unknown().optional(),
  endDate: z.unknown(),
  successDestination: z.unknown().optional(),
  failureDestination: z.unknown().optional(),
  milestones: z.unknown(),
}).strict()

/**
 * Formats a Zod issue into a structured { field, code, message } entry.
 */
export function formatZodIssue(issue) {
  let field = 'root'
  if (issue.path && issue.path.length > 0) {
    field = issue.path.reduce((acc, seg, i) => {
      if (typeof seg === 'number') return `${acc}[${seg}]`
      return i === 0 ? String(seg) : `${acc}.${String(seg)}`
    }, '')
  } else if (issue.code === 'unrecognized_keys' && issue.keys && issue.keys.length > 0) {
    field = issue.keys.join(', ')
  }

  let code = issue.code
  if (issue.code === 'custom' && issue.params?.code) {
    code = issue.params.code
  }

  return {
    field,
    code,
    message: issue.message,
  }
}

/**
 * Formats all issues in a ZodError into an array of { field, code, message }.
 * Handles unrecognized_keys with multiple keys by emitting one entry per key.
 */
export function formatZodError(error) {
  const details = []
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      const parentPath = issue.path && issue.path.length > 0
        ? issue.path.reduce((acc, seg, i) => {
            if (typeof seg === 'number') return `${acc}[${seg}]`
            return i === 0 ? String(seg) : `${acc}.${String(seg)}`
          }, '')
        : ''

      for (const key of issue.keys) {
        details.push({
          field: parentPath ? `${parentPath}.${key}` : key,
          code: 'unrecognized_keys',
          message: `Unrecognized key: "${key}"`,
        })
      }
    } else {
      details.push(formatZodIssue(issue))
    }
  }
  return details
}

/**
 * Validates a POST /vaults payload according to all business and contract rules.
 *
 * @param {unknown} payload
 * @param {object} [options]
 * @param {Date} [options.now] Current time override (for testing)
 * @returns {{ success: true, data: object } | { success: false, details: Array<{ field: string, code: string, message: string }> }}
 */
export function validateCreateVault(payload, options = {}) {
  const now = options.now ? new Date(options.now) : new Date()

  // First run basic schema parse for type & strict checks
  const firstPass = createVaultSchema.safeParse(payload)
  if (!firstPass.success) {
    return {
      success: false,
      details: formatZodError(firstPass.error),
    }
  }

  const issues = []
  const addIssue = (field, code, message) => {
    issues.push({ field, code, message })
  }

  const b = payload

  // 1. Stellar Addresses: creator & verifier
  if (typeof b.creator !== 'string' || !b.creator) {
    addIssue('creator', 'invalid_address', 'creator is required and must be a string')
  } else if (b.creator.startsWith('M')) {
    addIssue('creator', 'invalid_address', 'creator must be a Stellar G-address (muxed M-addresses are not supported)')
  } else if (!StrKey.isValidEd25519PublicKey(b.creator)) {
    addIssue('creator', 'invalid_address', 'creator must be a valid Stellar public key (G..., 56 characters with valid checksum)')
  }

  if (typeof b.verifier !== 'string' || !b.verifier) {
    addIssue('verifier', 'invalid_address', 'verifier is required and must be a string')
  } else if (b.verifier.startsWith('M')) {
    addIssue('verifier', 'invalid_address', 'verifier must be a Stellar G-address (muxed M-addresses are not supported)')
  } else if (!StrKey.isValidEd25519PublicKey(b.verifier)) {
    addIssue('verifier', 'invalid_address', 'verifier must be a valid Stellar public key (G..., 56 characters with valid checksum)')
  }

  // Role constraint: creator !== verifier
  if (b.creator && b.verifier && b.creator === b.verifier) {
    addIssue('verifier', 'invalid_role', 'verifier must not be equal to creator')
  }

  // 2. Optional destinations: successDestination, failureDestination
  if (b.successDestination !== undefined && b.successDestination !== null && b.successDestination !== '') {
    if (typeof b.successDestination !== 'string') {
      addIssue('successDestination', 'invalid_address', 'successDestination must be a valid Stellar public key')
    } else if (b.successDestination.startsWith('M')) {
      addIssue('successDestination', 'invalid_address', 'successDestination must be a Stellar G-address (muxed M-addresses are not supported)')
    } else if (!StrKey.isValidEd25519PublicKey(b.successDestination)) {
      addIssue('successDestination', 'invalid_address', 'successDestination must be a valid Stellar public key (G..., 56 characters with valid checksum)')
    }
  }

  if (b.failureDestination !== undefined && b.failureDestination !== null && b.failureDestination !== '') {
    if (typeof b.failureDestination !== 'string') {
      addIssue('failureDestination', 'invalid_address', 'failureDestination must be a valid Stellar public key')
    } else if (b.failureDestination.startsWith('M')) {
      addIssue('failureDestination', 'invalid_address', 'failureDestination must be a Stellar G-address (muxed M-addresses are not supported)')
    } else if (!StrKey.isValidEd25519PublicKey(b.failureDestination)) {
      addIssue('failureDestination', 'invalid_address', 'failureDestination must be a valid Stellar public key (G..., 56 characters with valid checksum)')
    } else if (b.failureDestination === b.creator) {
      addIssue('failureDestination', 'invalid_failure_destination', 'failureDestination must not be equal to creator')
    }
  }

  // 3. Amount parsing (preserve exact behavior: positive number <= 1e12)
  const amount = Number(b.amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    addIssue('amount', 'invalid_amount', 'amount must be a positive number')
  }

  // 4. Dates: startDate & endDate
  let startDate = null
  if (b.startDate !== undefined && b.startDate !== null && b.startDate !== '') {
    startDate = parseDateAsUtc(b.startDate)
    if (!startDate) {
      addIssue('startDate', 'invalid_date', 'startDate must be a valid date')
    } else {
      // startDate >= now - 5 min (clock skew)
      const minStart = now.getTime() - FIVE_MINUTES_MS
      if (startDate.getTime() < minStart) {
        addIssue('startDate', 'start_date_in_past', 'startDate must not be in the past (allowed clock skew: 5 minutes)')
      }
    }
  } else {
    startDate = new Date(now)
  }

  let endDate = null
  if (b.endDate === undefined || b.endDate === null || b.endDate === '') {
    addIssue('endDate', 'invalid_date', 'endDate is required')
  } else {
    endDate = parseDateAsUtc(b.endDate)
    if (!endDate) {
      addIssue('endDate', 'invalid_date', 'endDate must be a valid date')
    } else {
      if (startDate && endDate.getTime() <= startDate.getTime()) {
        addIssue('endDate', 'invalid_end_date', 'endDate must be strictly after startDate')
      }
      if (endDate.getTime() - now.getTime() > FIVE_YEARS_MS) {
        addIssue('endDate', 'horizon_exceeded', 'endDate must not be more than 5 years in the future')
      }
    }
  }

  // 5. Milestones
  if (!Array.isArray(b.milestones)) {
    addIssue('milestones', 'invalid_type', 'milestones must be an array')
  } else if (b.milestones.length < 1 || b.milestones.length > 20) {
    addIssue('milestones', 'invalid_length', 'between 1 and 20 milestones are required')
  } else {
    let prevDueDate = null

    b.milestones.forEach((m, i) => {
      const idx = `milestones[${i}]`
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        addIssue(idx, 'invalid_type', `milestone ${i + 1} must be an object`)
        return
      }

      // Check strict unknown keys in milestone
      const msPass = createMilestoneSchema.safeParse(m)
      if (!msPass.success) {
        for (const subIssue of msPass.error.issues) {
          if (subIssue.code === 'unrecognized_keys' && Array.isArray(subIssue.keys)) {
            for (const key of subIssue.keys) {
              addIssue(`${idx}.${key}`, 'unrecognized_keys', `Unrecognized key: "${key}"`)
            }
          }
        }
      }

      // Title validation
      if (typeof m.title !== 'string') {
        addIssue(`${idx}.title`, 'invalid_type', `milestone ${i + 1}: title is required`)
      } else {
        const trimmed = m.title.trim()
        if (trimmed.length === 0) {
          addIssue(`${idx}.title`, 'empty_title', `milestone ${i + 1}: title must not be empty`)
        } else {
          const byteLen = Buffer.byteLength(trimmed, 'utf8')
          if (byteLen > MAX_TITLE_BYTES) {
            addIssue(`${idx}.title`, 'title_too_long', `milestone ${i + 1}: title exceeds 128 bytes (actual: ${byteLen} bytes)`)
          }
        }
      }

      // Milestone amount
      const mAmount = Number(m.amount)
      if (!Number.isFinite(mAmount) || mAmount < 0) {
        addIssue(`${idx}.amount`, 'invalid_amount', `milestone ${i + 1}: amount must be >= 0`)
      }

      // Milestone dueDate
      let mDueDate = null
      if (m.dueDate !== undefined && m.dueDate !== null && m.dueDate !== '') {
        mDueDate = parseDateAsUtc(m.dueDate)
        if (!mDueDate) {
          addIssue(`${idx}.dueDate`, 'invalid_date', `milestone ${i + 1}: invalid dueDate`)
        }
      } else if (endDate) {
        // defaults to endDate
        mDueDate = new Date(endDate)
      }

      if (mDueDate) {
        if (startDate && mDueDate.getTime() <= startDate.getTime()) {
          addIssue(`${idx}.dueDate`, 'due_date_before_start', `milestone ${i + 1}: dueDate must be after startDate`)
        }
        if (endDate && mDueDate.getTime() > endDate.getTime()) {
          addIssue(`${idx}.dueDate`, 'due_date_after_end', `milestone ${i + 1}: dueDate must not be after endDate`)
        }
        if (prevDueDate && mDueDate.getTime() < prevDueDate.getTime()) {
          addIssue(`${idx}.dueDate`, 'due_dates_decreasing', `milestone ${i + 1}: due dates must be non-decreasing`)
        }
        prevDueDate = mDueDate
      }
    })
  }

  if (issues.length > 0) {
    return {
      success: false,
      details: issues,
    }
  }

  return {
    success: true,
    data: {
      name: typeof b.name === 'string' ? b.name.trim().slice(0, 200) : '',
      creator: b.creator,
      verifier: b.verifier,
      amount: String(amount),
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      successDestination: b.successDestination || b.creator,
      failureDestination: b.failureDestination || b.verifier,
      milestones: b.milestones.map((m, i) => {
        const mDueDate = m.dueDate ? parseDateAsUtc(m.dueDate) : endDate
        return {
          id: '',
          title: String(m.title || '').trim(),
          amount: String(Number(m.amount)),
          dueDate: mDueDate.toISOString(),
          status: 'pending',
          _i: i,
        }
      }),
    },
  }
}

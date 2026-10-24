// Amount module for Disciplr: exact 7-decimal values in stroops (i128 / numeric(36,7)).
// 1 unit = 10,000,000 stroops (10^7).

export const STROOPS_PER_UNIT = 10_000_000n
const MAX_I128 = (1n << 127n) - 1n
// In PostgreSQL numeric(36,7), there are 36 total digits and 7 fractional digits,
// so at most 29 integer digits. 10^29 - 1 in units = (10^29 - 1) * 10^7 stroops,
// which is well within i128 (approx 1.7 * 10^38).
const MAX_UNITS_INT_DIGITS = 29
const MAX_STROOPS = (10n ** 36n) - 1n // 36 total digits

const AMOUNT_FORMAT_REGEX = /^(0|[1-9]\d*)(\.\d+)?$/

/**
 * Parses an amount (string or number) into exact bigint stroops.
 * Accepts a JSON string or safe number with at most 7 decimals.
 * Rejects negative numbers, exponents, NaN, non-numeric strings,
 * decimals exceeding 7 places, and values exceeding bounds.
 *
 * Note on JSON numbers:
 * Inputs given as JSON numbers may already lose precision in JSON.parse.
 * To guarantee exact precision without floating point drift or scientific notation,
 * clients should send strings. If numbers are passed, they must be finite, non-negative,
 * and within safe integer stroop range (Number.isSafeInteger(n * 1e7)).
 *
 * @param {string|number} input
 * @returns {bigint} amount in stroops (1 unit = 10^7 stroops)
 */
export function parseAmount(input) {
  if (input === null || input === undefined) {
    throw new TypeError('Amount is required')
  }

  let str
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Number.isNaN(input)) {
      throw new TypeError('Amount must be a finite number')
    }
    if (input < 0) {
      throw new RangeError('Amount must be non-negative')
    }
    const raw = String(input)
    if (raw.includes('e') || raw.includes('E')) {
      throw new TypeError('Scientific notation is not supported for amounts')
    }
    // Only accept numbers when Number.isSafeInteger(n * 1e7)
    const stroopsCandidate = Math.round(input * 1e7)
    if (!Number.isSafeInteger(stroopsCandidate) || Math.abs(input * 1e7 - stroopsCandidate) > 1e-5) {
      throw new RangeError('Number exceeds safe decimal precision; please provide amount as string')
    }
    str = raw
  } else if (typeof input === 'string') {
    str = input.trim()
  } else {
    throw new TypeError('Amount must be a string or number')
  }

  if (!str) {
    throw new TypeError('Amount cannot be empty')
  }

  if (str.startsWith('-')) {
    throw new RangeError('Amount must be non-negative')
  }

  if (str.includes('e') || str.includes('E')) {
    throw new TypeError('Scientific notation is not supported for amounts')
  }

  if (!AMOUNT_FORMAT_REGEX.test(str)) {
    throw new TypeError(`Invalid amount format: "${str}"`)
  }

  const [intPart, fracPart = ''] = str.split('.')
  if (intPart.length > MAX_UNITS_INT_DIGITS) {
    throw new RangeError('Amount exceeds maximum allowed digits')
  }

  if (fracPart.length > 7) {
    throw new RangeError('Amount cannot have more than 7 decimal places')
  }

  const paddedFrac = fracPart.padEnd(7, '0')
  const stroops = BigInt(intPart) * STROOPS_PER_UNIT + BigInt(paddedFrac)

  if (stroops > MAX_STROOPS || stroops > MAX_I128) {
    throw new RangeError('Amount exceeds maximum range')
  }

  return stroops
}

/**
 * Formats bigint stroops into canonical string without trailing zeros.
 * If fractional part is 0, outputs an integer string.
 *
 * @param {bigint} stroops
 * @returns {string} canonical amount string (e.g. "100", "0.1", "33.3333333")
 */
export function formatAmount(stroops) {
  if (typeof stroops !== 'bigint') {
    throw new TypeError('formatAmount expects a bigint')
  }
  if (stroops < 0n) {
    throw new RangeError('Amount must be non-negative')
  }

  const intPart = stroops / STROOPS_PER_UNIT
  const fracPart = stroops % STROOPS_PER_UNIT

  if (fracPart === 0n) {
    return intPart.toString()
  }

  let fracStr = fracPart.toString().padStart(7, '0')
  // Remove trailing zeros
  fracStr = fracStr.replace(/0+$/, '')

  return `${intPart.toString()}.${fracStr}`
}

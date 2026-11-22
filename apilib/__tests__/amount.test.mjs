import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, formatAmount } from '../amount.mjs'

let fc = null
try {
  fc = (await import('fast-check')).default
} catch {
  // fallback if fast-check not found in environment
}

test('amount - parseAmount rejects null, undefined, empty, or wrong type', () => {
  assert.throws(() => parseAmount(null), TypeError)
  assert.throws(() => parseAmount(undefined), TypeError)
  assert.throws(() => parseAmount(''), TypeError)
  assert.throws(() => parseAmount('   '), TypeError)
  assert.throws(() => parseAmount({}), TypeError)
  assert.throws(() => parseAmount([]), TypeError)
  assert.throws(() => parseAmount(true), TypeError)
})

test('amount - parseAmount rejects negative, exponent notation, NaN, Infinity', () => {
  assert.throws(() => parseAmount('-1'), RangeError)
  assert.throws(() => parseAmount(-1), RangeError)
  assert.throws(() => parseAmount('1e3'), TypeError)
  assert.throws(() => parseAmount('1E-3'), TypeError)
  assert.throws(() => parseAmount(NaN), TypeError)
  assert.throws(() => parseAmount(Infinity), TypeError)
  assert.throws(() => parseAmount(-Infinity), TypeError)
  assert.throws(() => parseAmount('abc'), TypeError)
  assert.throws(() => parseAmount('12.34.56'), TypeError)
  assert.throws(() => parseAmount('+100'), TypeError)
  assert.throws(() => parseAmount('0100'), TypeError)
  assert.throws(() => parseAmount(1e25), Error)
})

test('amount - parseAmount rejects more than 7 decimal places', () => {
  assert.throws(() => parseAmount('0.00000001'), RangeError)
  assert.throws(() => parseAmount('1.12345678'), RangeError)
  assert.throws(() => parseAmount('100.00000001'), RangeError)
})

test('amount - parseAmount accepts exact 7-decimal places', () => {
  assert.equal(parseAmount('0.0000001'), 1n)
  assert.equal(formatAmount(1n), '0.0000001')
  assert.equal(formatAmount(parseAmount('0.0000001')), '0.0000001')
})

test('amount - boundary cases round-trip exactly', () => {
  // 0
  assert.equal(parseAmount('0'), 0n)
  assert.equal(formatAmount(0n), '0')

  // "922337203685.4775807" (near i64 max in stroops: 9223372036854775807n)
  const nearI64Max = '922337203685.4775807'
  const nearI64MaxStroops = 9223372036854775807n
  assert.equal(parseAmount(nearI64Max), nearI64MaxStroops)
  assert.equal(formatAmount(nearI64MaxStroops), nearI64Max)
  assert.equal(formatAmount(parseAmount(nearI64Max)), nearI64Max)

  // 100
  assert.equal(parseAmount('100'), 1000000000n)
  assert.equal(formatAmount(1000000000n), '100')
})

test('amount - formatAmount rejects non-bigint or negative', () => {
  assert.throws(() => formatAmount(100), TypeError)
  assert.throws(() => formatAmount('100'), TypeError)
  assert.throws(() => formatAmount(-1n), RangeError)
})

// Canonical helper: strips trailing zeros from fractional part, or returns intPart if all zeros
function canonical(s) {
  const [intPart, fracPart] = s.split('.')
  if (!fracPart) return intPart
  const trimmed = fracPart.replace(/0+$/, '')
  return trimmed ? `${intPart}.${trimmed}` : intPart
}

test('amount - property-based tests with fast-check (or fallback)', () => {
  if (fc) {
    const integerPartArb = fc.bigInt({ min: 0n, max: 1_000_000_000_000n }).map(n => n.toString())
    const decimalPartArb = fc.stringMatching(/^[0-9]{1,7}$/)

    const validAmountStringArb = fc.oneof(
      integerPartArb,
      fc.tuple(integerPartArb, decimalPartArb).map(([intP, fracP]) => `${intP}.${fracP}`)
    )

    fc.assert(
      fc.property(validAmountStringArb, (str) => {
        const stroops = parseAmount(str)
        const formatted = formatAmount(stroops)
        return formatted === canonical(str)
      }),
      { numRuns: 1000 }
    )
  } else {
    // Randomized property tests generating 1000 random 0-7 decimal strings
    for (let i = 0; i < 1000; i++) {
      const intPart = Math.floor(Math.random() * 1000000000).toString()
      const hasDec = Math.random() > 0.3
      let str = intPart
      if (hasDec) {
        const decLen = Math.floor(Math.random() * 7) + 1
        let frac = ''
        for (let j = 0; j < decLen; j++) frac += Math.floor(Math.random() * 10).toString()
        str = `${intPart}.${frac}`
      }
      const stroops = parseAmount(str)
      const formatted = formatAmount(stroops)
      assert.equal(formatted, canonical(str))
    }
  }
})

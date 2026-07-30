/**
 * XDR scval decoding boundary tests for the Horizon event parser.
 *
 * Directly exercises the low-level `i128` and `Address` decoding that
 * `eventParser.decodeScValRecord` relies on (`xdr.ScVal` + `scValToNative`),
 * plus the parser's listener-safety guarantee that malformed payloads yield a
 * typed `{ success: false }` result instead of throwing.
 *
 * Cross-references: `docs/horizon-events.md`, `docs/contract_errors.md`.
 */
import { describe, expect, it } from '@jest/globals'
import {
  Address,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { parseHorizonEvent } from '../services/eventParser.js'
import { createRawHorizonEvent } from './fixtures/horizonEvents.js'

/** Largest positive value representable by a signed 128-bit integer. */
const MAX_I128 = 2n ** 127n - 1n // 170141183460469231731687303715884105727
/** Smallest (most negative) value representable by a signed 128-bit integer. */
const MIN_I128 = -(2n ** 127n)

/** Encode an i128 scval and decode it back to its native bigint. */
function roundTripI128(value: bigint): unknown {
  const scv = nativeToScVal(value, { type: 'i128' })
  return scValToNative(scv)
}

describe('eventParser scval decoding — i128 amounts', () => {
  it('decodes zero to the bigint 0n', () => {
    expect(roundTripI128(0n)).toBe(0n)
  })

  it('decodes a large stroop amount without precision loss', () => {
    // 10,000,000.0000000 XLM expressed in stroops (7 decimal places).
    const largeStroops = 100_000_000_000_000n
    expect(roundTripI128(largeStroops)).toBe(largeStroops)
  })

  it('decodes the maximum positive i128 value', () => {
    expect(roundTripI128(MAX_I128)).toBe(MAX_I128)
  })

  it('decodes the minimum (most negative) i128 value', () => {
    expect(roundTripI128(MIN_I128)).toBe(MIN_I128)
  })

  it('decodes the max i128 built from explicit hi/lo Int128Parts', () => {
    // hi = i64::MAX, lo = u64::MAX → the i128 max boundary.
    const scv = xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString('9223372036854775807'),
        lo: xdr.Uint64.fromString('18446744073709551615'),
      }),
    )
    expect(scValToNative(scv)).toBe(MAX_I128)
  })

  it('decodes i128 to a bigint, never a lossy JS number', () => {
    expect(typeof roundTripI128(MAX_I128)).toBe('bigint')
  })
})

describe('eventParser scval decoding — Address types', () => {
  it('decodes an account address to a G-strkey', () => {
    const account = Address.account(Buffer.alloc(32, 1))
    const decoded = scValToNative(account.toScVal()) as string
    expect(decoded).toBe(account.toString())
    expect(decoded.startsWith('G')).toBe(true)
  })

  it('decodes a contract address to a C-strkey', () => {
    const contract = Address.contract(Buffer.alloc(32, 2))
    const decoded = scValToNative(contract.toScVal()) as string
    expect(decoded).toBe(contract.toString())
    expect(decoded.startsWith('C')).toBe(true)
  })

  it('round-trips a randomly generated account public key', () => {
    const publicKey = Keypair.random().publicKey()
    const decoded = scValToNative(Address.fromString(publicKey).toScVal())
    expect(decoded).toBe(publicKey)
  })

  it('keeps account and contract strkey forms distinct', () => {
    const account = scValToNative(Address.account(Buffer.alloc(32, 3)).toScVal()) as string
    const contract = scValToNative(Address.contract(Buffer.alloc(32, 3)).toScVal()) as string
    expect(account).not.toBe(contract)
    expect(account[0]).toBe('G')
    expect(contract[0]).toBe('C')
  })
})

describe('eventParser scval decoding — malformed payloads are typed errors, not throws', () => {
  it('returns a typed parse error for a truncated scval payload', () => {
    const rawEvent = createRawHorizonEvent(
      'vault_created',
      {},
      { value: { xdr: 'AAAAAA' } }, // not a valid scval encoding
    )

    let result!: ReturnType<typeof parseHorizonEvent>
    expect(() => {
      result = parseHorizonEvent(rawEvent)
    }).not.toThrow()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(typeof result.error).toBe('string')
    }
  })

  it('returns a typed parse error for an unexpected (non-map) scval type', () => {
    // A bare u32 scalar decodes to a number, not the object the parser expects.
    const scalarXdr = nativeToScVal(42, { type: 'u32' }).toXDR('base64')
    const rawEvent = createRawHorizonEvent(
      'vault_created',
      {},
      { value: { xdr: scalarXdr } },
    )

    let result!: ReturnType<typeof parseHorizonEvent>
    expect(() => {
      result = parseHorizonEvent(rawEvent)
    }).not.toThrow()

    expect(result.success).toBe(false)
  })

  it('returns a typed parse error for an empty topic', () => {
    const rawEvent = createRawHorizonEvent(
      'vault_created',
      { vaultId: '550e8400-e29b-41d4-a716-446655440000' },
      { topic: [] },
    )

    const result = parseHorizonEvent(rawEvent)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('topic')
    }
  })
})
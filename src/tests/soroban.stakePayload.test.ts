import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { MemoTooLongError } from '../types/vaults.js'

// Avoid importing the heavy @stellar/stellar-sdk dynamic loader — we don't
// touch the network path here, only the payload builders.
jest.unstable_mockModule('../observability/tracing.js', () => ({
  getTracer: () => ({
    withSpan: async (_name: string, fn: (span: any) => Promise<unknown>) =>
      fn({ setAttribute: () => undefined, addEvent: () => undefined, recordException: () => undefined, setStatus: () => undefined }),
  }),
}))

const soroban = await import('../services/soroban.js')
const { MEMO_MAX_BYTES, buildVaultStakePayload, buildVaultStakeWithMemoPayload, buildStakePayload, buildStakeWithMemoPayload } = soroban as any

describe('buildStakePayload (#977)', () => {
  beforeEach(() => {
    delete process.env.SOROBAN_CONTRACT_ID
    delete process.env.SOROBAN_NETWORK_PASSPHRASE
    delete process.env.SOROBAN_SOURCE_ACCOUNT
  })

  it('returns a payload with method "stake" and the input args', () => {
    const payload = buildStakePayload({
      vaultId: 'vault-1',
      amount: '1000',
      user: 'GABC',
    })

    expect(payload.method).toBe('stake')
    expect(payload.args).toEqual({ vaultId: 'vault-1', amount: '1000', user: 'GABC' })
  })

  it('falls back to environment defaults', () => {
    process.env.SOROBAN_CONTRACT_ID = 'CONTRACT_FROM_ENV'
    process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
    process.env.SOROBAN_SOURCE_ACCOUNT = 'SOURCE_FROM_ENV'

    const payload = buildStakePayload({ vaultId: 'v', amount: '1', user: 'GXYZ' })
    expect(payload.contractId).toBe('CONTRACT_FROM_ENV')
    expect(payload.sourceAccount).toBe('SOURCE_FROM_ENV')
  })

  it('lets input.onChain override env values', () => {
    process.env.SOROBAN_CONTRACT_ID = 'CONTRACT_FROM_ENV'
    const payload = buildStakePayload({
      vaultId: 'v',
      amount: '1',
      user: 'GXYZ',
      onChain: {
        contractId: 'CONTRACT_FROM_INPUT',
        networkPassphrase: 'PUBLIC',
        sourceAccount: 'SOURCE_FROM_INPUT',
      },
    })
    expect(payload.contractId).toBe('CONTRACT_FROM_INPUT')
    expect(payload.networkPassphrase).toBe('PUBLIC')
    expect(payload.sourceAccount).toBe('SOURCE_FROM_INPUT')
  })

  it('is idempotent: repeated calls with same input produce identical payloads', () => {
    const a = buildStakePayload({ vaultId: 'vault-1', amount: '1000', user: 'GABC' })
    const b = buildStakePayload({ vaultId: 'vault-1', amount: '1000', user: 'GABC' })
    expect(a).toEqual(b)
  })
})

describe('buildStakeWithMemoPayload — MEMO_MAX_BYTES validation (#977)', () => {
  it('accepts a memo that decodes to exactly MEMO_MAX_BYTES bytes', () => {
    const memoHex = 'aa'.repeat(MEMO_MAX_BYTES)
    const payload = buildStakeWithMemoPayload({
      vaultId: 'vault-1',
      amount: '100',
      user: 'GABC',
      memo: memoHex,
    })
    expect(payload.method).toBe('stake_with_memo')
    expect(payload.args.memo).toBe(memoHex)
  })

  it('accepts a memo that decodes to less than MEMO_MAX_BYTES', () => {
    const memoHex = 'ab'.repeat(MEMO_MAX_BYTES - 1)
    const payload = buildStakeWithMemoPayload({
      vaultId: 'vault-1',
      amount: '100',
      user: 'GABC',
      memo: memoHex,
    })
    expect(payload.args.memo).toBe(memoHex)
  })

  it('throws MemoTooLongError when decoded memo exceeds MEMO_MAX_BYTES', () => {
    const memoHex = 'ff'.repeat(MEMO_MAX_BYTES + 1)
    expect(() =>
      buildStakeWithMemoPayload({
        vaultId: 'vault-1',
        amount: '100',
        user: 'GABC',
        memo: memoHex,
      }),
    ).toThrow(MemoTooLongError)
  })

  it('returns a payload without a memo field when memo is omitted', () => {
    const payload = buildStakeWithMemoPayload({
      vaultId: 'vault-1',
      amount: '100',
      user: 'GABC',
    })
    expect(payload.method).toBe('stake_with_memo')
    expect(payload.args).toEqual({ vaultId: 'vault-1', amount: '100', user: 'GABC' })
    expect(payload.args.memo).toBeUndefined()
  })

  it('returns a payload without a memo field when memo is the empty string', () => {
    const payload = buildStakeWithMemoPayload({
      vaultId: 'vault-1',
      amount: '100',
      user: 'GABC',
      memo: '',
    })
    expect(payload.args.memo).toBeUndefined()
  })

  it('throws on non-hex memo (odd length)', () => {
    expect(() =>
      buildStakeWithMemoPayload({
        vaultId: 'vault-1',
        amount: '100',
        user: 'GABC',
        memo: 'z',
      }),
    ).toThrow(/even-length/i)
  })

  it('throws on non-hex memo (invalid characters)', () => {
    expect(() =>
      buildStakeWithMemoPayload({
        vaultId: 'vault-1',
        amount: '100',
        user: 'GABC',
        memo: 'zzzz',
      }),
    ).toThrow(/non-hex/i)
  })
})

describe('buildVaultStakePayload — wrapper contract (#977)', () => {
  beforeEach(() => {
    delete process.env.SOROBAN_CONTRACT_ID
    delete process.env.SOROBAN_NETWORK_PASSPHRASE
    delete process.env.SOROBAN_SOURCE_ACCOUNT
    delete process.env.SOROBAN_RPC_URLS
    delete process.env.SOROBAN_RPC_URL
    delete process.env.SOROBAN_SECRET_KEY
  })

  it('returns mode=build and not_requested by default', async () => {
    const out = await buildVaultStakePayload({
      vaultId: 'v',
      amount: '1',
      user: 'GABC',
    })

    expect(out.mode).toBe('build')
    expect(out.payload.method).toBe('stake')
    expect(out.submission).toEqual({ attempted: false, status: 'not_requested' })
  })

  it('returns not_configured when submit mode is requested but env is missing', async () => {
    const out = await buildVaultStakePayload({
      vaultId: 'v',
      amount: '1',
      user: 'GABC',
      onChain: { mode: 'submit' },
    })
    expect(out.mode).toBe('submit')
    expect(out.submission.status).toBe('not_configured')
  })
})

describe('buildVaultStakeWithMemoPayload — wrapper contract (#977)', () => {
  beforeEach(() => {
    delete process.env.SOROBAN_CONTRACT_ID
    delete process.env.SOROBAN_NETWORK_PASSPHRASE
    delete process.env.SOROBAN_SOURCE_ACCOUNT
    delete process.env.SOROBAN_RPC_URLS
    delete process.env.SOROBAN_RPC_URL
    delete process.env.SOROBAN_SECRET_KEY
  })

  it('returns mode=build and not_requested by default', async () => {
    const out = await buildVaultStakeWithMemoPayload({
      vaultId: 'v',
      amount: '1',
      user: 'GABC',
      memo: 'aa',
    })
    expect(out.mode).toBe('build')
    expect(out.payload.method).toBe('stake_with_memo')
    expect(out.submission).toEqual({ attempted: false, status: 'not_requested' })
  })

  it('propagates MemoTooLongError before doing any submit work', async () => {
    await expect(
      buildVaultStakeWithMemoPayload({
        vaultId: 'v',
        amount: '1',
        user: 'GABC',
        memo: 'ff'.repeat(MEMO_MAX_BYTES + 5),
        onChain: { mode: 'submit' },
      }),
    ).rejects.toThrow(/memo/i)
  })
})

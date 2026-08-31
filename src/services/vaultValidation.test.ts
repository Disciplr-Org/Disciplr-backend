/* eslint-env jest */
import {
  getClassicAddress,
  createVaultSchema,
  assertValidVaultCreateResponse,
  getConfiguredNetworkPassphrase,
} from './vaultValidation.js'

describe('getClassicAddress', () => {
  it('returns original address for valid classic address', () => {
    const classic = 'GAP3SREQTGBQADRB5QUVLWC4RZZ62MFMQZ5CCEYMMCVQF7GFREISGZGL'
    expect(getClassicAddress(classic)).toBe(classic)
  })

  it('decodes and returns classic address for valid muxed address', () => {
    const muxed = 'MAP3SREQTGBQADRB5QUVLWC4RZZ62MFMQZ5CCEYMMCVQF7GFREISHLPU'
    const expectedClassic = 'GAP3SREQTGBQADRB5QUVLWC4RZZ62MFMQZ5CCEYMMCVQF7GFREISGZGL'
    expect(getClassicAddress(muxed)).toBe(expectedClassic)
  })

  it('throws an error for malformed muxed address', () => {
    const malformed = 'M1234567890'
    expect(() => getClassicAddress(malformed)).toThrow('Invalid muxed address format')
  })

  it('returns original string for non-muxed, non-classic unrecognized strings', () => {
    const randomStr = 'random_string'
    expect(getClassicAddress(randomStr)).toBe(randomStr)
  })
})

// ─── Vault-create boundary: onChain network / wallet / contract validation ──

const G = 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB'
const G2 = 'GAT7KQ5MRI34Y5M52Z2GZGQMOAZXUEGPV3U5SERQZQE4HHYBE4SH3X2N'
const G3 = 'GBWUD4PUYATGWVDMNN3VRQZL45GSY2ZG5QCWNM4AUGYXDCFKMQUF33JU'

const validBody = (overrides: Record<string, unknown> = {}) => ({
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: G,
  destinations: { success: G2, failure: G3 },
  milestones: [
    { title: 'Kickoff', dueDate: '2030-02-01T00:00:00.000Z', amount: '300' },
    { title: 'Final review', dueDate: '2030-05-01T00:00:00.000Z', amount: '700' },
  ],
  ...overrides,
})

describe('createVaultSchema onChain boundary validation', () => {
  const previousPassphrase = process.env.SOROBAN_NETWORK_PASSPHRASE

  beforeAll(() => {
    process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
  })

  afterAll(() => {
    if (previousPassphrase === undefined) {
      delete process.env.SOROBAN_NETWORK_PASSPHRASE
    } else {
      process.env.SOROBAN_NETWORK_PASSPHRASE = previousPassphrase
    }
  })

  it('accepts an onChain block whose network passphrase matches the configured network', () => {
    const result = createVaultSchema.safeParse(
      validBody({
        onChain: {
          mode: 'build',
          contractId: `C${'A'.repeat(55)}`,
          networkPassphrase: getConfiguredNetworkPassphrase(),
          sourceAccount: G,
        },
      }),
    )
    expect(result.success).toBe(true)
  })

  it('rejects a wrong-network passphrase at the boundary', () => {
    const result = createVaultSchema.safeParse(
      validBody({
        onChain: { networkPassphrase: 'Public Global Stellar Network ; September 2015' },
      }),
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'onChain.networkPassphrase')
      expect(issue).toBeDefined()
      expect(issue!.message).toMatch(/network passphrase/i)
    }
  })

  it('rejects a malformed contract id', () => {
    const result = createVaultSchema.safeParse(
      validBody({ onChain: { contractId: 'GABBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFB' } }),
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'onChain.contractId')
      expect(issue).toBeDefined()
    }
  })

  it('rejects a malformed source account', () => {
    const result = createVaultSchema.safeParse(
      validBody({ onChain: { sourceAccount: 'not-a-stellar-address' } }),
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'onChain.sourceAccount')
      expect(issue).toBeDefined()
    }
  })

  it('accepts a valid onChain block with no overrides', () => {
    const result = createVaultSchema.safeParse(validBody({ onChain: { mode: 'submit' } }))
    expect(result.success).toBe(true)
  })
})

// ─── Vault-create boundary: server response shape guard ─────────────────────

const validResponse = {
  vault: { id: 'vault-1', amount: '1000', status: 'draft' },
  onChain: {
    payload: {
      contractId: `C${'A'.repeat(55)}`,
      networkPassphrase: 'Test SDF Network ; September 2015',
      sourceAccount: G,
      method: 'create_vault',
      args: {},
    },
    submission: { attempted: false, status: 'not_requested' },
  },
  idempotency: { key: 'key-1', replayed: false },
}

describe('assertValidVaultCreateResponse', () => {
  it('accepts a well-formed vault create response', () => {
    expect(() => assertValidVaultCreateResponse(validResponse)).not.toThrow()
  })

  it('rejects non-object responses', () => {
    expect(() => assertValidVaultCreateResponse(null)).toThrow(/must be an object/)
    expect(() => assertValidVaultCreateResponse('string')).toThrow(/must be an object/)
    expect(() => assertValidVaultCreateResponse(42)).toThrow(/must be an object/)
  })

  it('rejects a response without a vault object', () => {
    expect(() => assertValidVaultCreateResponse({ onChain: validResponse.onChain })).toThrow(/vault object/)
  })

  it('rejects a response with an empty vault id', () => {
    expect(() =>
      assertValidVaultCreateResponse({ vault: { id: '' }, onChain: validResponse.onChain }),
    ).toThrow(/vault id/)
  })

  it('rejects a response without an onChain payload', () => {
    expect(() =>
      assertValidVaultCreateResponse({ vault: { id: 'vault-1' } }),
    ).toThrow(/onChain/)
  })

  it('rejects an onChain payload that is not a create_vault method', () => {
    expect(() =>
      assertValidVaultCreateResponse({
        vault: { id: 'vault-1' },
        onChain: { payload: { method: 'withdraw' } },
      }),
    ).toThrow(/onChain payload/)
  })
})

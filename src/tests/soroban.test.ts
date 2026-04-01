import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import type { CreateVaultInput, PersistedVault } from '../types/vaults.js'
import {
  buildVaultCreationPayload,
  getSorobanConfig,
  isSorobanSubmitEnabled,
  setSorobanClient,
  resetSorobanClient,
  type SorobanClient,
  type SorobanConfig,
} from '../services/soroban.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const stellar = (): string => `G${'A'.repeat(55)}`

const makeInput = (overrides: Partial<CreateVaultInput> = {}): CreateVaultInput => ({
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: stellar(),
  destinations: { success: stellar(), failure: stellar() },
  milestones: [
    { title: 'Kickoff', dueDate: '2030-02-01T00:00:00.000Z', amount: '300' },
    { title: 'Final', dueDate: '2030-05-01T00:00:00.000Z', amount: '700' },
  ],
  ...overrides,
})

const makeVault = (overrides: Partial<PersistedVault> = {}): PersistedVault => ({
  id: 'vault-test-abc123',
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: stellar(),
  successDestination: stellar(),
  failureDestination: stellar(),
  creator: stellar(),
  status: 'draft',
  createdAt: '2025-03-25T00:00:00.000Z',
  milestones: [
    {
      id: 'ms-1',
      vaultId: 'vault-test-abc123',
      title: 'Kickoff',
      description: null,
      dueDate: '2030-02-01T00:00:00.000Z',
      amount: '300',
      sortOrder: 0,
      createdAt: '2025-03-25T00:00:00.000Z',
    },
    {
      id: 'ms-2',
      vaultId: 'vault-test-abc123',
      title: 'Final',
      description: null,
      dueDate: '2030-05-01T00:00:00.000Z',
      amount: '700',
      sortOrder: 1,
      createdAt: '2025-03-25T00:00:00.000Z',
    },
  ],
  ...overrides,
})

// ─── Env helpers ─────────────────────────────────────────────────────────────

const FULL_ENV = {
  SOROBAN_CONTRACT_ID: 'CABCDEF1234567890',
  SOROBAN_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  SOROBAN_SOURCE_ACCOUNT: stellar(),
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  SOROBAN_SECRET_KEY: 'SCZANGBA5YHTNYVVV3C7CAZMCLPVAR3LXKLHEADMPROMU3QAHZGOSN6A',
}

const savedEnv: Record<string, string | undefined> = {}

const setEnv = (vars: Record<string, string>): void => {
  for (const [key, value] of Object.entries(vars)) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
}

const clearSorobanEnv = (): void => {
  for (const key of Object.keys(FULL_ENV)) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
}

const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

// ─── Mock client factory ─────────────────────────────────────────────────────

const createMockClient = (
  result?: { txHash: string },
  error?: Error,
): { client: SorobanClient; spy: jest.Mock } => {
  const spy = jest.fn<SorobanClient['submitVaultCreation']>()
  if (error) {
    spy.mockRejectedValue(error)
  } else {
    spy.mockResolvedValue(result ?? { txHash: 'mock-tx-hash-abc123' })
  }
  return {
    client: { submitVaultCreation: spy },
    spy,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('soroban service', () => {
  beforeEach(() => {
    clearSorobanEnv()
  })

  afterEach(() => {
    restoreEnv()
    resetSorobanClient()
  })

  // ─── getSorobanConfig ───────────────────────────────────────────

  describe('getSorobanConfig', () => {
    it('returns null when no env vars are set', () => {
      expect(getSorobanConfig()).toBeNull()
    })

    it('returns null when only some env vars are set', () => {
      setEnv({
        SOROBAN_CONTRACT_ID: 'CABCDEF',
        SOROBAN_RPC_URL: 'https://rpc.example.com',
      })
      expect(getSorobanConfig()).toBeNull()
    })

    it('returns config when all env vars are present', () => {
      setEnv(FULL_ENV)
      const config = getSorobanConfig()
      expect(config).not.toBeNull()
      expect(config!.contractId).toBe(FULL_ENV.SOROBAN_CONTRACT_ID)
      expect(config!.rpcUrl).toBe(FULL_ENV.SOROBAN_RPC_URL)
      expect(config!.secretKey).toBe(FULL_ENV.SOROBAN_SECRET_KEY)
    })
  })

  // ─── isSorobanSubmitEnabled ─────────────────────────────────────

  describe('isSorobanSubmitEnabled', () => {
    it('returns false when env is not configured', () => {
      expect(isSorobanSubmitEnabled()).toBe(false)
    })

    it('returns true when fully configured', () => {
      setEnv(FULL_ENV)
      expect(isSorobanSubmitEnabled()).toBe(true)
    })
  })

  // ─── buildVaultCreationPayload — build mode ─────────────────────

  describe('buildVaultCreationPayload (mode=build)', () => {
    it('returns not_requested submission when mode is build', async () => {
      const input = makeInput()
      const vault = makeVault()

      const result = await buildVaultCreationPayload(input, vault)

      expect(result.mode).toBe('build')
      expect(result.payload.method).toBe('create_vault')
      expect(result.submission.attempted).toBe(false)
      expect(result.submission.status).toBe('not_requested')
      expect(result.submission.txHash).toBeUndefined()
    })

    it('defaults to build mode when onChain is undefined', async () => {
      const input = makeInput({ onChain: undefined })
      const vault = makeVault()

      const result = await buildVaultCreationPayload(input, vault)

      expect(result.mode).toBe('build')
      expect(result.submission.status).toBe('not_requested')
    })

    it('includes vault args in payload', async () => {
      const vault = makeVault()
      const result = await buildVaultCreationPayload(makeInput(), vault)

      expect(result.payload.args.vaultId).toBe(vault.id)
      expect(result.payload.args.amount).toBe(vault.amount)
      expect(result.payload.args.verifier).toBe(vault.verifier)
      expect(result.payload.args.successDestination).toBe(vault.successDestination)
      expect(result.payload.args.failureDestination).toBe(vault.failureDestination)
    })

    it('maps milestones correctly', async () => {
      const vault = makeVault()
      const result = await buildVaultCreationPayload(makeInput(), vault)

      const milestones = result.payload.args.milestones as Array<Record<string, unknown>>
      expect(milestones).toHaveLength(2)
      expect(milestones[0]).toEqual({
        id: 'ms-1',
        title: 'Kickoff',
        amount: '300',
        dueDate: '2030-02-01T00:00:00.000Z',
      })
    })

    it('uses env-based contractId when input.onChain.contractId is absent', async () => {
      setEnv({ SOROBAN_CONTRACT_ID: 'ENV_CONTRACT_ID' })
      const result = await buildVaultCreationPayload(makeInput(), makeVault())
      expect(result.payload.contractId).toBe('ENV_CONTRACT_ID')
    })

    it('prefers input.onChain.contractId over env', async () => {
      setEnv({ SOROBAN_CONTRACT_ID: 'ENV_CONTRACT_ID' })
      const input = makeInput({ onChain: { mode: 'build', contractId: 'INPUT_CONTRACT' } })
      const result = await buildVaultCreationPayload(input, makeVault())
      expect(result.payload.contractId).toBe('INPUT_CONTRACT')
    })

    it('falls back to DEFAULT_CONTRACT_ID when nothing is configured', async () => {
      const result = await buildVaultCreationPayload(makeInput(), makeVault())
      expect(result.payload.contractId).toBe('CONTRACT_ID_NOT_CONFIGURED')
    })
  })

  // ─── buildVaultCreationPayload — submit mode, not configured ────

  describe('buildVaultCreationPayload (mode=submit, not configured)', () => {
    it('returns not_configured when env is incomplete', async () => {
      const input = makeInput({ onChain: { mode: 'submit' } })
      const vault = makeVault()

      const result = await buildVaultCreationPayload(input, vault)

      expect(result.mode).toBe('submit')
      expect(result.submission.attempted).toBe(true)
      expect(result.submission.status).toBe('not_configured')
      expect(result.submission.txHash).toBeUndefined()
    })

    it('still includes the full payload even when not configured', async () => {
      const input = makeInput({ onChain: { mode: 'submit' } })
      const vault = makeVault()

      const result = await buildVaultCreationPayload(input, vault)

      expect(result.payload.method).toBe('create_vault')
      expect(result.payload.args.vaultId).toBe(vault.id)
    })
  })

  // ─── buildVaultCreationPayload — submit mode, configured + mocked SDK ──

  describe('buildVaultCreationPayload (mode=submit, configured)', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('submits successfully and returns txHash', async () => {
      const expectedHash = 'tx-hash-from-soroban-network'
      const { client, spy } = createMockClient({ txHash: expectedHash })
      setSorobanClient(client)

      const input = makeInput({ onChain: { mode: 'submit' } })
      const vault = makeVault()

      const result = await buildVaultCreationPayload(input, vault)

      expect(result.mode).toBe('submit')
      expect(result.submission.attempted).toBe(true)
      expect(result.submission.status).toBe('success')
      expect(result.submission.txHash).toBe(expectedHash)
      expect(result.submission.error).toBeUndefined()

      // Verify the mock client was called with the right config and args
      expect(spy).toHaveBeenCalledTimes(1)
      const [passedConfig, passedArgs] = spy.mock.calls[0]
      expect(passedConfig.contractId).toBe(FULL_ENV.SOROBAN_CONTRACT_ID)
      expect(passedConfig.secretKey).toBe(FULL_ENV.SOROBAN_SECRET_KEY)
      expect(passedArgs.vaultId).toBe(vault.id)
    })

    it('returns error status when submission fails', async () => {
      const { client } = createMockClient(undefined, new Error('RPC timeout'))
      setSorobanClient(client)

      const input = makeInput({ onChain: { mode: 'submit' } })
      const vault = makeVault()

      const result = await buildVaultCreationPayload(input, vault)

      expect(result.submission.attempted).toBe(true)
      expect(result.submission.status).toBe('error')
      expect(result.submission.error).toBe('RPC timeout')
      expect(result.submission.txHash).toBeUndefined()
    })

    it('handles non-Error thrown values gracefully', async () => {
      const spy = jest.fn<SorobanClient['submitVaultCreation']>().mockRejectedValue('string-error')
      setSorobanClient({ submitVaultCreation: spy })

      const input = makeInput({ onChain: { mode: 'submit' } })
      const result = await buildVaultCreationPayload(input, makeVault())

      expect(result.submission.status).toBe('error')
      expect(result.submission.error).toBe('Unknown submission error')
    })

    it('does not leak secret key or PII in the response', async () => {
      const { client } = createMockClient({ txHash: 'safe-hash' })
      setSorobanClient(client)

      const input = makeInput({ onChain: { mode: 'submit' } })
      const result = await buildVaultCreationPayload(input, makeVault())
      const serialized = JSON.stringify(result)

      expect(serialized).not.toContain(FULL_ENV.SOROBAN_SECRET_KEY)
      expect(serialized).not.toContain('SCZANGBA') // prefix of test secret
    })

    it('passes full config to the client including rpcUrl', async () => {
      const { client, spy } = createMockClient()
      setSorobanClient(client)

      await buildVaultCreationPayload(
        makeInput({ onChain: { mode: 'submit' } }),
        makeVault(),
      )

      const [passedConfig] = spy.mock.calls[0]
      expect(passedConfig.rpcUrl).toBe(FULL_ENV.SOROBAN_RPC_URL)
      expect(passedConfig.networkPassphrase).toBe(FULL_ENV.SOROBAN_NETWORK_PASSPHRASE)
    })
  })

  // ─── Idempotent client behaviour ───────────────────────────────

  describe('idempotent client behaviour', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('produces identical payload structure on repeated calls with same vault', async () => {
      const { client } = createMockClient({ txHash: 'hash-1' })
      setSorobanClient(client)

      const input = makeInput({ onChain: { mode: 'submit' } })
      const vault = makeVault()

      const result1 = await buildVaultCreationPayload(input, vault)
      const result2 = await buildVaultCreationPayload(input, vault)

      // Payload shape is always the same regardless of call count
      expect(result1.payload).toEqual(result2.payload)
      expect(result1.mode).toBe(result2.mode)
    })

    it('build mode calls never invoke the client', async () => {
      const { client, spy } = createMockClient()
      setSorobanClient(client)

      const input = makeInput({ onChain: { mode: 'build' } })
      await buildVaultCreationPayload(input, makeVault())
      await buildVaultCreationPayload(input, makeVault())

      expect(spy).not.toHaveBeenCalled()
    })
  })

  // ─── Structured logging ────────────────────────────────────────

  describe('logging', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('logs on submit start and success without PII', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      const { client } = createMockClient({ txHash: 'logged-hash' })
      setSorobanClient(client)

      await buildVaultCreationPayload(
        makeInput({ onChain: { mode: 'submit' } }),
        makeVault(),
      )

      const calls = logSpy.mock.calls.map((c) => c[0] as string)
      const startLog = calls.find((c) => c.includes('soroban.submit_start'))
      const successLog = calls.find((c) => c.includes('soroban.submit_success'))

      expect(startLog).toBeDefined()
      expect(successLog).toBeDefined()
      expect(successLog).toContain('logged-hash')

      // Ensure no secret key leakage in logs
      for (const entry of calls) {
        expect(entry).not.toContain(FULL_ENV.SOROBAN_SECRET_KEY)
      }

      logSpy.mockRestore()
    })

    it('logs on submit error', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const { client } = createMockClient(undefined, new Error('network failure'))
      setSorobanClient(client)

      await buildVaultCreationPayload(
        makeInput({ onChain: { mode: 'submit' } }),
        makeVault(),
      )

      const calls = errorSpy.mock.calls.map((c) => c[0] as string)
      const errorLog = calls.find((c) => c.includes('soroban.submit_error'))
      expect(errorLog).toBeDefined()
      expect(errorLog).toContain('network failure')

      errorSpy.mockRestore()
    })

    it('logs warning when submit attempted but not configured', async () => {
      clearSorobanEnv()
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      await buildVaultCreationPayload(
        makeInput({ onChain: { mode: 'submit' } }),
        makeVault(),
      )

      const calls = logSpy.mock.calls.map((c) => c[0] as string)
      // warn goes to console.log in our structured logger at warn level
      // Actually it goes to console.log for warn level
      const warnLog = calls.find((c) => c.includes('soroban.submit_not_configured'))
      expect(warnLog).toBeDefined()

      logSpy.mockRestore()
    })
  })

  // ─── Edge cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles vault with empty milestones array', async () => {
      const vault = makeVault({ milestones: [] })
      const result = await buildVaultCreationPayload(makeInput(), vault)

      const milestones = result.payload.args.milestones as unknown[]
      expect(milestones).toEqual([])
    })

    it('handles vault with null creator', async () => {
      const vault = makeVault({ creator: null })
      const result = await buildVaultCreationPayload(makeInput(), vault)

      expect(result.payload.args.vaultId).toBe(vault.id)
    })

    it('returns correct default networkPassphrase when env is not set', async () => {
      const result = await buildVaultCreationPayload(makeInput(), makeVault())
      expect(result.payload.networkPassphrase).toBe('Test SDF Network ; September 2015')
    })

    it('returns correct default sourceAccount when env is not set', async () => {
      const result = await buildVaultCreationPayload(makeInput(), makeVault())
      expect(result.payload.sourceAccount).toBe('SOURCE_ACCOUNT_NOT_CONFIGURED')
    })
  })
})

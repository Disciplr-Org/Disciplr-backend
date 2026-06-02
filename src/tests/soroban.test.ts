import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import type { CreateVaultInput, PersistedVault } from '../types/vaults.js'
import {
  buildVaultCreationPayload,
  getSorobanConfig,
  isSorobanSubmitEnabled,
  setSorobanClient,
  resetSorobanClient,
  createDefaultSorobanClient,
  type SorobanClient,
  type SorobanConfig,
  submitStake,
  submitCheckIn,
  submitSlash,
  submitClaim,
  submitWithdraw,
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

const FAST_SUBMIT_ENV = {
  RETRY_MAX_ATTEMPTS: '2',
  RETRY_BACKOFF_MS: '1',
  SOROBAN_SUBMIT_POLL_INTERVAL_MS: '1',
  SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS: '3',
  SOROBAN_RPC_TIMEOUT_MS: '50',
  SOROBAN_SUBMIT_RETRY_MAX_BACKOFF_MS: '2',
}

const savedEnv: Record<string, string | undefined> = {}

const rememberEnv = (key: string): void => {
  if (!Object.prototype.hasOwnProperty.call(savedEnv, key)) {
    savedEnv[key] = process.env[key]
  }
}

const setEnv = (vars: Record<string, string>): void => {
  for (const [key, value] of Object.entries(vars)) {
    rememberEnv(key)
    process.env[key] = value
  }
}

const clearSorobanEnv = (): void => {
  for (const key of [...Object.keys(FULL_ENV), ...Object.keys(FAST_SUBMIT_ENV)]) {
    rememberEnv(key)
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
    delete savedEnv[key]
  }
}

// ─── Mock client factory ─────────────────────────────────────────────────────

const createMockClient = (
  result?: { txHash: string },
  error?: Error,
): { client: SorobanClient; spies: Record<string, jest.Mock> } => {
  const spies: Record<string, jest.Mock> = {
    submitVaultCreation: jest.fn<SorobanClient['submitVaultCreation']>(),
    submitStake: jest.fn<SorobanClient['submitStake']>(),
    submitCheckIn: jest.fn<SorobanClient['submitCheckIn']>(),
    submitSlash: jest.fn<SorobanClient['submitSlash']>(),
    submitClaim: jest.fn<SorobanClient['submitClaim']>(),
    submitWithdraw: jest.fn<SorobanClient['submitWithdraw']>(),
  }

  if (error) {
    Object.values(spies).forEach((spy) => spy.mockRejectedValue(error))
  } else {
    Object.values(spies).forEach((spy) => spy.mockResolvedValue(result ?? { txHash: 'mock-tx-hash-abc123' }))
  }

  return {
    client: {
      submitVaultCreation: spies.submitVaultCreation,
      submitStake: spies.submitStake,
      submitCheckIn: spies.submitCheckIn,
      submitSlash: spies.submitSlash,
      submitClaim: spies.submitClaim,
      submitWithdraw: spies.submitWithdraw,
    },
    spies,
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

    it('includes bounded submit retry, poll, and timeout settings', () => {
      setEnv({ ...FULL_ENV, ...FAST_SUBMIT_ENV })
      const config = getSorobanConfig()

      expect(config).not.toBeNull()
      expect(config!.submitPollIntervalMs).toBe(1)
      expect(config!.submitPollMaxAttempts).toBe(3)
      expect(config!.rpcTimeoutMs).toBe(50)
      expect(config!.submitRetry.maxAttempts).toBe(2)
      expect(config!.submitRetry.initialBackoffMs).toBe(1)
      expect(config!.submitRetry.maxBackoffMs).toBe(2)
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
      const { client, spies } = createMockClient({ txHash: expectedHash })
      setSorobanClient(client)

      const input = makeInput({ onChain: { mode: 'submit' } })
      const vault = makeVault()

      const result = await buildVaultCreationPayload(input, vault)

      expect(result.mode).toBe('submit')
      expect(result.submission.attempted).toBe(true)
      expect(result.submission.status).toBe('success')
      expect(result.submission.txHash).toBe(expectedHash)
      expect(result.submission.error).toBeUndefined()

      expect(spies.submitVaultCreation).toHaveBeenCalledTimes(1)
      const [passedConfig, passedArgs] = spies.submitVaultCreation.mock.calls[0] as [SorobanConfig, Record<string, any>]
      expect(passedConfig.contractId).toBe(FULL_ENV.SOROBAN_CONTRACT_ID)
      expect(passedConfig.secretKey).toBe(FULL_ENV.SOROBAN_SECRET_KEY)
      expect(passedArgs.vaultId).toBe(vault.id)
    })

    it('returns error status with generic message when submission fails with non-contract error', async () => {
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

    it('returns structured error when submission fails with contract error', async () => {
      const { client } = createMockClient(undefined, new Error('HostError: Error(Contract, 4)'))
      setSorobanClient(client)

      const input = makeInput({ onChain: { mode: 'submit' } })
      const vault = makeVault()

      const result = await buildVaultCreationPayload(input, vault)

      expect(result.submission.attempted).toBe(true)
      expect(result.submission.status).toBe('error')
      expect(result.submission.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Invalid deadline',
        details: { contractErrorCode: 4 },
      })
      expect(result.submission.txHash).toBeUndefined()
    })

    it('handles non-Error thrown values gracefully', async () => {
      const submitVaultCreation = jest.fn<SorobanClient['submitVaultCreation']>().mockRejectedValue('string-error')
      setSorobanClient({
        submitVaultCreation,
        submitStake: jest.fn(),
        submitCheckIn: jest.fn(),
        submitSlash: jest.fn(),
        submitClaim: jest.fn(),
        submitWithdraw: jest.fn(),
      })

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
      expect(serialized).not.toContain('SCZANGBA')
    })

    it('passes full config to the client including rpcUrl', async () => {
      const { client, spies } = createMockClient()
      setSorobanClient(client)

      await buildVaultCreationPayload(
        makeInput({ onChain: { mode: 'submit' } }),
        makeVault(),
      )

      const [passedConfig] = spies.submitVaultCreation.mock.calls[0] as [SorobanConfig, any]
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
      const { client, spies } = createMockClient()
      setSorobanClient(client)

      const input = makeInput({ onChain: { mode: 'build' } })
      await buildVaultCreationPayload(input, makeVault())
      await buildVaultCreationPayload(input, makeVault())

      expect(spies.submitVaultCreation).not.toHaveBeenCalled()
    })
  })

  // ─── Default Soroban client retry and polling behaviour ─────────

  describe('defaultSorobanClient retry and polling', () => {
    const makeFakeSdk = (server: Record<string, jest.Mock>) => {
      class FakeContract {
        call = jest.fn(() => ({ type: 'operation' }))
      }

      class FakeTransactionBuilder {
        addOperation = jest.fn(() => this)
        setTimeout = jest.fn(() => this)
        build = jest.fn(() => ({ type: 'transaction' }))
      }

      return {
        Keypair: { fromSecret: jest.fn(() => ({ publicKey: jest.fn() })) },
        Contract: FakeContract,
        rpc: { SorobanRpc: undefined, Server: jest.fn(() => server) },
        Networks: {},
        TransactionBuilder: FakeTransactionBuilder,
        nativeToScVal: jest.fn((value: unknown) => value),
        BASE_FEE: '100',
      }
    }

    const makeSubmitConfig = (): SorobanConfig => {
      setEnv({ ...FULL_ENV, ...FAST_SUBMIT_ENV })
      const config = getSorobanConfig()
      expect(config).not.toBeNull()
      return config!
    }

    it('retries transient getAccount failures with backoff', async () => {
      const server = {
        getAccount: jest
          .fn()
          .mockRejectedValueOnce(new Error('connection reset'))
          .mockResolvedValue({ accountId: FULL_ENV.SOROBAN_SOURCE_ACCOUNT }),
        prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx-retry-account' }),
        getTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
      }
      const client = createDefaultSorobanClient(async () => makeFakeSdk(server))

      await expect(client.submitVaultCreation(makeSubmitConfig(), makeVault() as any)).resolves.toEqual({
        txHash: 'tx-retry-account',
      })

      expect(server.getAccount).toHaveBeenCalledTimes(2)
      expect(server.sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('retries transient sendTransaction failures before polling', async () => {
      const server = {
        getAccount: jest.fn().mockResolvedValue({ accountId: FULL_ENV.SOROBAN_SOURCE_ACCOUNT }),
        prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
        sendTransaction: jest
          .fn()
          .mockRejectedValueOnce(new Error('RPC timeout'))
          .mockResolvedValue({ status: 'PENDING', hash: 'tx-retry-send' }),
        getTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
      }
      const client = createDefaultSorobanClient(async () => makeFakeSdk(server))

      await expect(client.submitVaultCreation(makeSubmitConfig(), makeVault() as any)).resolves.toEqual({
        txHash: 'tx-retry-send',
      })

      expect(server.sendTransaction).toHaveBeenCalledTimes(2)
      expect(server.getTransaction).toHaveBeenCalledTimes(1)
    })

    it('uses configurable polling interval and max attempts', async () => {
      const server = {
        getAccount: jest.fn().mockResolvedValue({ accountId: FULL_ENV.SOROBAN_SOURCE_ACCOUNT }),
        prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx-polled' }),
        getTransaction: jest
          .fn()
          .mockResolvedValueOnce({ status: 'NOT_FOUND' })
          .mockResolvedValueOnce({ status: 'NOT_FOUND' })
          .mockResolvedValue({ status: 'SUCCESS' }),
      }
      const client = createDefaultSorobanClient(async () => makeFakeSdk(server))

      await expect(client.submitVaultCreation(makeSubmitConfig(), makeVault() as any)).resolves.toEqual({
        txHash: 'tx-polled',
      })

      expect(server.getTransaction).toHaveBeenCalledTimes(3)
    })

    it('fails when polling exhausts the configured max attempts', async () => {
      const server = {
        getAccount: jest.fn().mockResolvedValue({ accountId: FULL_ENV.SOROBAN_SOURCE_ACCOUNT }),
        prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx-not-found' }),
        getTransaction: jest.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
      }
      const client = createDefaultSorobanClient(async () => makeFakeSdk(server))

      await expect(client.submitVaultCreation(makeSubmitConfig(), makeVault() as any)).rejects.toThrow(
        'Soroban transaction did not succeed: NOT_FOUND',
      )

      expect(server.getTransaction).toHaveBeenCalledTimes(3)
    })

    it('bounds stalled RPC calls with a timeout', async () => {
      setEnv({ ...FULL_ENV, ...FAST_SUBMIT_ENV, RETRY_MAX_ATTEMPTS: '1', SOROBAN_RPC_TIMEOUT_MS: '1' })
      const config = getSorobanConfig()
      expect(config).not.toBeNull()

      const server = {
        getAccount: jest.fn(() => new Promise(() => {})),
        prepareTransaction: jest.fn(),
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
      }
      const client = createDefaultSorobanClient(async () => makeFakeSdk(server))

      await expect(client.submitVaultCreation(config!, makeVault() as any)).rejects.toThrow(
        'Soroban RPC getAccount timed out after 1ms',
      )
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

   // ─── Lifecycle methods: not configured ─────────────────────────────────────

   describe('lifecycle methods (not configured)', () => {
     it('submitStake returns not_configured when env is incomplete', async () => {
       const result = await submitStake('vault-123', '1000')

       expect(result.method).toBe('stake')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('not_configured')
       expect(result.submission.txHash).toBeUndefined()
       expect(result.args.vaultId).toBe('vault-123')
       expect(result.args.amount).toBe('1000')
     })

     it('submitCheckIn returns not_configured when env is incomplete', async () => {
       const result = await submitCheckIn('vault-123', 'milestone-456')

       expect(result.method).toBe('check_in')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('not_configured')
       expect(result.submission.txHash).toBeUndefined()
       expect(result.args.vaultId).toBe('vault-123')
       expect(result.args.milestoneId).toBe('milestone-456')
     })

     it('submitSlash returns not_configured when env is incomplete', async () => {
       const result = await submitSlash('vault-123', 'milestone-456')

       expect(result.method).toBe('slash_on_miss')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('not_configured')
       expect(result.submission.txHash).toBeUndefined()
     })

     it('submitClaim returns not_configured when env is incomplete', async () => {
       const result = await submitClaim('vault-123')

       expect(result.method).toBe('claim')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('not_configured')
       expect(result.submission.txHash).toBeUndefined()
     })

     it('submitWithdraw returns not_configured when env is incomplete', async () => {
       const result = await submitWithdraw('vault-123')

       expect(result.method).toBe('withdraw')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('not_configured')
       expect(result.submission.txHash).toBeUndefined()
     })
   })

   // ─── Lifecycle methods: configured + success ───────────────────────────────

   describe('lifecycle methods (configured)', () => {
     it('submitStake submits successfully', async () => {
       const { client, spies } = createMockClient({ txHash: 'stake-hash-123' })
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitStake('vault-stake', '500')

       expect(result.method).toBe('stake')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('success')
       expect(result.submission.txHash).toBe('stake-hash-123')
       expect(spies.submitStake).toHaveBeenCalledTimes(1)
     })

     it('submitCheckIn submits successfully', async () => {
       const { client, spies } = createMockClient({ txHash: 'checkin-hash-456' })
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitCheckIn('vault-checkin', 'ms-checkin')

       expect(result.method).toBe('check_in')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('success')
       expect(result.submission.txHash).toBe('checkin-hash-456')
       expect(spies.submitCheckIn).toHaveBeenCalledTimes(1)
     })

     it('submitSlash submits successfully', async () => {
       const { client, spies } = createMockClient({ txHash: 'slash-hash-789' })
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitSlash('vault-slash', 'ms-slash')

       expect(result.method).toBe('slash_on_miss')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('success')
       expect(result.submission.txHash).toBe('slash-hash-789')
       expect(spies.submitSlash).toHaveBeenCalledTimes(1)
     })

     it('submitClaim submits successfully', async () => {
       const { client, spies } = createMockClient({ txHash: 'claim-hash-abc' })
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitClaim('vault-claim')

       expect(result.method).toBe('claim')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('success')
       expect(result.submission.txHash).toBe('claim-hash-abc')
       expect(spies.submitClaim).toHaveBeenCalledTimes(1)
     })

     it('submitWithdraw submits successfully', async () => {
       const { client, spies } = createMockClient({ txHash: 'withdraw-hash-def' })
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitWithdraw('vault-withdraw')

       expect(result.method).toBe('withdraw')
       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('success')
       expect(result.submission.txHash).toBe('withdraw-hash-def')
       expect(spies.submitWithdraw).toHaveBeenCalledTimes(1)
     })
   })

   // ─── Lifecycle methods: error handling ─────────────────────────────────────

   describe('lifecycle methods error handling', () => {
     it('submitStake returns error status when submission fails', async () => {
       const { client } = createMockClient(undefined, new Error('stake RPC error'))
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitStake('vault-err', '100')

       expect(result.submission.attempted).toBe(true)
       expect(result.submission.status).toBe('error')
       expect(result.submission.error).toBe('stake RPC error')
     })

     it('submitCheckIn returns error status when submission fails', async () => {
       const { client } = createMockClient(undefined, new Error('check-in RPC error'))
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitCheckIn('vault-err', 'ms-err')

       expect(result.submission.status).toBe('error')
       expect(result.submission.error).toBe('check-in RPC error')
     })

     it('submitSlash returns error status when submission fails', async () => {
       const { client } = createMockClient(undefined, new Error('slash RPC error'))
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitSlash('vault-err', 'ms-err')

       expect(result.submission.status).toBe('error')
       expect(result.submission.error).toBe('slash RPC error')
     })

     it('submitClaim returns error status when submission fails', async () => {
       const { client } = createMockClient(undefined, new Error('claim RPC error'))
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitClaim('vault-err')

       expect(result.submission.status).toBe('error')
       expect(result.submission.error).toBe('claim RPC error')
     })

     it('submitWithdraw returns error status when submission fails', async () => {
       const { client } = createMockClient(undefined, new Error('withdraw RPC error'))
       setSorobanClient(client)
       setEnv(FULL_ENV)

       const result = await submitWithdraw('vault-err')

       expect(result.submission.status).toBe('error')
       expect(result.submission.error).toBe('withdraw RPC error')
     })

     it('lifecycle methods handle non-Error thrown values gracefully', async () => {
       const submitStakeSpy = jest.fn<SorobanClient['submitStake']>().mockRejectedValue('string-error')
       setSorobanClient({
         submitVaultCreation: jest.fn(),
         submitStake: submitStakeSpy,
         submitCheckIn: jest.fn(),
         submitSlash: jest.fn(),
         submitClaim: jest.fn(),
         submitWithdraw: jest.fn(),
       })
       setEnv(FULL_ENV)

       const result = await submitStake('vault-grace', '100')

       expect(result.submission.status).toBe('error')
       expect(result.submission.error).toBe('Unknown stake error')
     })
   })

   // ─── Lifecycle methods: logging ───────────────────────────────────────────

   describe('lifecycle methods logging', () => {
     it('logs on submitStake start and success without PII', async () => {
       const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
       const { client } = createMockClient({ txHash: 'stake-log-hash' })
       setSorobanClient(client)
       setEnv(FULL_ENV)

       await submitStake('vault-log', '200')

       const calls = logSpy.mock.calls.map((c) => c[0] as string)
       const startLog = calls.find((c) => c.includes('soroban.stake_start'))
       const successLog = calls.find((c) => c.includes('soroban.stake_success'))

       expect(startLog).toBeDefined()
       expect(successLog).toBeDefined()
       expect(successLog).toContain('stake-log-hash')

       for (const entry of calls) {
         expect(entry).not.toContain(FULL_ENV.SOROBAN_SECRET_KEY)
       }

       logSpy.mockRestore()
     })

     it('logs on submitCheckIn error', async () => {
       const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
       const { client } = createMockClient(undefined, new Error('checkin-failure'))
       setSorobanClient(client)
       setEnv(FULL_ENV)

       await submitCheckIn('vault-log', 'ms-log')

       const calls = errorSpy.mock.calls.map((c) => c[0] as string)
       const errorLog = calls.find((c) => c.includes('soroban.check_in_error'))
       expect(errorLog).toBeDefined()
       expect(errorLog).toContain('checkin-failure')

       errorSpy.mockRestore()
     })

     it('logs warning when lifecycle method attempted but not configured', async () => {
       clearSorobanEnv()
       const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

       await submitClaim('vault-warn')

       const calls = logSpy.mock.calls.map((c) => c[0] as string)
       const warnLog = calls.find((c) => c.includes('soroban.claim_not_configured'))
       expect(warnLog).toBeDefined()

       logSpy.mockRestore()
     })
   })

   // ─── Lifecycle methods: no PII in response ───────────────────────────────────

   describe('lifecycle methods PII protection', () => {
     it('does not leak secret key in any lifecycle response', async () => {
       setEnv(FULL_ENV)
       const { client } = createMockClient({ txHash: 'pii-test-hash' })
       setSorobanClient(client)

       const stakeResult = await submitStake('vault-pii', '100')
       const checkInResult = await submitCheckIn('vault-pii', 'ms-pii')
       const slashResult = await submitSlash('vault-pii', 'ms-pii')
       const claimResult = await submitClaim('vault-pii')
       const withdrawResult = await submitWithdraw('vault-pii')

       const serialized = JSON.stringify({ stakeResult, checkInResult, slashResult, claimResult, withdrawResult })

       expect(serialized).not.toContain(FULL_ENV.SOROBAN_SECRET_KEY)
       expect(serialized).not.toContain('SCZANGBA')
     })
   })
 })

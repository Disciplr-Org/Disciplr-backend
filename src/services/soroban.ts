import type { CreateVaultInput, PersistedVault, VaultCreateResponse } from '../types/vaults.js'
import { retryWithBackoff, sleep, type RetryConfig } from '../utils/retry.js'

const DEFAULT_CONTRACT_ID = 'CONTRACT_ID_NOT_CONFIGURED'
const DEFAULT_SOURCE_ACCOUNT = 'SOURCE_ACCOUNT_NOT_CONFIGURED'
const DEFAULT_SUBMIT_POLL_INTERVAL_MS = 1000
const DEFAULT_SUBMIT_POLL_MAX_ATTEMPTS = 30
const DEFAULT_RPC_TIMEOUT_MS = 30_000
const DEFAULT_SUBMIT_RETRY_MAX_ATTEMPTS = 3
const DEFAULT_SUBMIT_RETRY_BACKOFF_MS = 100
const DEFAULT_SUBMIT_RETRY_MAX_BACKOFF_MS = 5_000
const DEFAULT_SUBMIT_RETRY_BACKOFF_MULTIPLIER = 2
const DEFAULT_SUBMIT_RETRY_JITTER_FACTOR = 0.5

// ─── Soroban configuration resolved from env ────────────────────────────────

export interface SorobanConfig {
  contractId: string
  networkPassphrase: string
  sourceAccount: string
  rpcUrl: string
  secretKey: string
  submitPollIntervalMs: number
  submitPollMaxAttempts: number
  rpcTimeoutMs: number
  submitRetry: RetryConfig
}

const positiveIntFromEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const getSubmitRetryConfig = (): RetryConfig => ({
  maxAttempts: positiveIntFromEnv('RETRY_MAX_ATTEMPTS', DEFAULT_SUBMIT_RETRY_MAX_ATTEMPTS),
  initialBackoffMs: positiveIntFromEnv('RETRY_BACKOFF_MS', DEFAULT_SUBMIT_RETRY_BACKOFF_MS),
  maxBackoffMs: positiveIntFromEnv('SOROBAN_SUBMIT_RETRY_MAX_BACKOFF_MS', DEFAULT_SUBMIT_RETRY_MAX_BACKOFF_MS),
  backoffMultiplier: DEFAULT_SUBMIT_RETRY_BACKOFF_MULTIPLIER,
  jitterFactor: DEFAULT_SUBMIT_RETRY_JITTER_FACTOR,
})

/**
 * Returns the Soroban config only when ALL required env vars are present.
 * Acts as the feature-flag: if any var is missing, submit mode is unavailable.
 */
export const getSorobanConfig = (): SorobanConfig | null => {
  const contractId = process.env.SOROBAN_CONTRACT_ID
  const networkPassphrase = process.env.SOROBAN_NETWORK_PASSPHRASE
  const sourceAccount = process.env.SOROBAN_SOURCE_ACCOUNT
  const rpcUrl = process.env.SOROBAN_RPC_URL
  const secretKey = process.env.SOROBAN_SECRET_KEY

  if (!contractId || !networkPassphrase || !sourceAccount || !rpcUrl || !secretKey) {
    return null
  }

  return {
    contractId,
    networkPassphrase,
    sourceAccount,
    rpcUrl,
    secretKey,
    submitPollIntervalMs: positiveIntFromEnv('SOROBAN_SUBMIT_POLL_INTERVAL_MS', DEFAULT_SUBMIT_POLL_INTERVAL_MS),
    submitPollMaxAttempts: positiveIntFromEnv('SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS', DEFAULT_SUBMIT_POLL_MAX_ATTEMPTS),
    rpcTimeoutMs: positiveIntFromEnv('SOROBAN_RPC_TIMEOUT_MS', DEFAULT_RPC_TIMEOUT_MS),
    submitRetry: getSubmitRetryConfig(),
  }
}

/**
 * Whether the backend is configured to submit Soroban transactions.
 * Useful for health checks and observability.
 */
export const isSorobanSubmitEnabled = (): boolean => getSorobanConfig() !== null

// ─── Internal helper for transaction submission ───────────────────────────────

/**
 * Common transaction submission logic shared by all contract methods.
 * Handles prepare, sign, send, and poll for completion.
 */
async function submitTransaction(
  config: SorobanConfig,
  methodName: string,
  scVals: any[],
): Promise<{ txHash: string }> {
  const {
    Keypair,
    Contract,
    rpc: SorobanRpc,
    TransactionBuilder,
    nativeToScVal,
    BASE_FEE,
  } = await import('@stellar/stellar-sdk')

  const server = new SorobanRpc.Server(config.rpcUrl)
  const keypair = Keypair.fromSecret(config.secretKey)
  const account = await server.getAccount(config.sourceAccount)

  const contract = new Contract(config.contractId)
  const callOp = contract.call(methodName, ...scVals)

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(callOp)
    .setTimeout(30)
    .build()

  const prepared = await server.prepareTransaction(tx)
  prepared.sign(keypair)

  const response = await server.sendTransaction(prepared)

  if (response.status === 'ERROR') {
    throw new Error(`Soroban sendTransaction failed: ${response.status}`)
  }

  let getResponse = await server.getTransaction(response.hash)
  const maxAttempts = 30
  let attempts = 0
  while (getResponse.status === 'NOT_FOUND' && attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 1000))
    getResponse = await server.getTransaction(response.hash)
    attempts++
  }

  if (getResponse.status !== 'SUCCESS') {
    throw new Error(`Soroban transaction did not succeed: ${getResponse.status}`)
  }

  return { txHash: response.hash }
}

// ─── Soroban SDK abstraction (mockable for tests) ───────────────────────────

/**
 * Thin wrapper around the Stellar SDK operations needed for submit.
 * Extracted as a named export so tests can replace it without touching env.
 */
export interface SorobanClient {
  submitVaultCreation(
    config: SorobanConfig,
    args: Record<string, unknown>,
  ): Promise<{ txHash: string }>
  submitStake(
    config: SorobanConfig,
    args: Record<string, unknown>,
  ): Promise<{ txHash: string }>
  submitCheckIn(
    config: SorobanConfig,
    args: Record<string, unknown>,
  ): Promise<{ txHash: string }>
  submitSlash(
    config: SorobanConfig,
    args: Record<string, unknown>,
  ): Promise<{ txHash: string }>
  submitClaim(
    config: SorobanConfig,
    args: Record<string, unknown>,
  ): Promise<{ txHash: string }>
  submitWithdraw(
    config: SorobanConfig,
    args: Record<string, unknown>,
  ): Promise<{ txHash: string }>
}

type StellarSdkLoader = () => Promise<any>

const withRpcTimeout = async <T>(
  operation: Promise<T>,
  operationName: string,
  timeoutMs: number,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Soroban RPC ${operationName} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const isRetryableSorobanRpcError = (error: Error): boolean => {
  const message = error.message.toLowerCase()
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('connection') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('socket') ||
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('503') ||
    message.includes('502') ||
    message.includes('504')
  )
}

const retryRpc = async <T>(
  operationName: string,
  config: SorobanConfig,
  operation: () => Promise<T>,
): Promise<T> => {
  return retryWithBackoff(
    () => withRpcTimeout(operation(), operationName, config.rpcTimeoutMs),
    config.submitRetry,
    isRetryableSorobanRpcError,
  )
}

/**
 * Default production client that calls the real Stellar SDK.
 * Imported lazily so the module loads even when @stellar/stellar-sdk
 * is not fully configured (e.g. in unit test environments).
 */
export const createDefaultSorobanClient = (
  loadSdk: StellarSdkLoader = () => import('@stellar/stellar-sdk'),
): SorobanClient => ({
  async submitVaultCreation(config, args) {
    const { nativeToScVal } = await import('@stellar/stellar-sdk')
    return submitTransaction(
      config,
      'create_vault',
      [
        nativeToScVal(args.vaultId, { type: 'string' }),
        nativeToScVal(args.amount, { type: 'string' }),
        nativeToScVal(args.verifier, { type: 'string' }),
        nativeToScVal(args.successDestination, { type: 'string' }),
        nativeToScVal(args.failureDestination, { type: 'string' }),
      ],
    )
  },

  async submitStake(config, args) {
    const { nativeToScVal } = await import('@stellar/stellar-sdk')
    return submitTransaction(
      config,
      'stake',
      [
        nativeToScVal(args.vaultId, { type: 'string' }),
        nativeToScVal(args.amount, { type: 'string' }),
      ],
    )
  },

  async submitCheckIn(config, args) {
    const { nativeToScVal } = await import('@stellar/stellar-sdk')
    return submitTransaction(
      config,
      'check_in',
      [
        nativeToScVal(args.vaultId, { type: 'string' }),
        nativeToScVal(args.milestoneId, { type: 'string' }),
      ],
    )
  },

  async submitSlash(config, args) {
    const { nativeToScVal } = await import('@stellar/stellar-sdk')
    return submitTransaction(
      config,
      'slash_on_miss',
      [
        nativeToScVal(args.vaultId, { type: 'string' }),
        nativeToScVal(args.milestoneId, { type: 'string' }),
      ],
    )
  },

  async submitClaim(config, args) {
    const { nativeToScVal } = await import('@stellar/stellar-sdk')
    return submitTransaction(
      config,
      'claim',
      [nativeToScVal(args.vaultId, { type: 'string' })],
    )
  },

  async submitWithdraw(config, args) {
    const { nativeToScVal } = await import('@stellar/stellar-sdk')
    return submitTransaction(
      config,
      'withdraw',
      [nativeToScVal(args.vaultId, { type: 'string' })],
    )
  },
})

export const defaultSorobanClient: SorobanClient = createDefaultSorobanClient()

// Allow overriding the client (for tests)
let _client: SorobanClient = defaultSorobanClient

export const setSorobanClient = (client: SorobanClient): void => {
  _client = client
}

export const resetSorobanClient = (): void => {
  _client = defaultSorobanClient
}

// ─── Structured logging helper (no PII) ─────────────────────────────────────

const log = (level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown> = {}): void => {
  const entry = {
    level,
    service: 'disciplr-backend',
    component: 'soroban',
    event,
    ts: new Date().toISOString(),
    ...data,
  }
  if (level === 'error') {
    console.error(JSON.stringify(entry))
  } else {
    console.log(JSON.stringify(entry))
  }
}

// ─── Build payload (existing behaviour, unchanged for mode=build) ───────────

const buildPayload = (
  input: CreateVaultInput,
  vault: PersistedVault,
): VaultCreateResponse['onChain']['payload'] => {
  return {
    contractId: input.onChain?.contractId ?? process.env.SOROBAN_CONTRACT_ID ?? DEFAULT_CONTRACT_ID,
    networkPassphrase:
      input.onChain?.networkPassphrase ?? process.env.SOROBAN_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
    sourceAccount: input.onChain?.sourceAccount ?? process.env.SOROBAN_SOURCE_ACCOUNT ?? DEFAULT_SOURCE_ACCOUNT,
    method: 'create_vault',
    args: {
      vaultId: vault.id,
      amount: vault.amount,
      verifier: vault.verifier,
      successDestination: vault.successDestination,
      failureDestination: vault.failureDestination,
      milestones: vault.milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        amount: milestone.amount,
        dueDate: milestone.dueDate,
      })),
    },
  }
}

// ─── Types for lifecycle method responses ───────────────────────────────────

export interface VaultLifecycleResponse {
  method: string
  args: Record<string, unknown>
  submission: {
    attempted: boolean
    status: 'success' | 'not_configured' | 'error'
    txHash?: string
    error?: string
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Builds the on-chain payload for vault creation.
 * When mode is 'submit' AND the backend is fully configured, performs an
 * actual Soroban transaction submission. The call is idempotent on the
 * client side: repeated calls with the same vault id produce the same
 * payload structure (the contract itself must enforce on-chain idempotency).
 *
 * Feature-flagged: real submission only occurs when SOROBAN_CONTRACT_ID,
 * SOROBAN_NETWORK_PASSPHRASE, SOROBAN_SOURCE_ACCOUNT, SOROBAN_RPC_URL,
 * and SOROBAN_SECRET_KEY are all set in the environment.
 */
export const buildVaultCreationPayload = async (
  input: CreateVaultInput,
  vault: PersistedVault,
): Promise<VaultCreateResponse['onChain']> => {
  const mode = input.onChain?.mode ?? 'build'
  const payload = buildPayload(input, vault)

  if (mode !== 'submit') {
    return {
      mode,
      payload,
      submission: { attempted: false, status: 'not_requested' },
    }
  }

  const config = getSorobanConfig()
  if (!config) {
    log('warn', 'soroban.submit_not_configured', { vaultId: vault.id })
    return {
      mode,
      payload,
      submission: { attempted: true, status: 'not_configured' },
    }
  }

  try {
    log('info', 'soroban.submit_start', { vaultId: vault.id })
    const { txHash } = await _client.submitVaultCreation(config, payload.args)
    log('info', 'soroban.submit_success', { vaultId: vault.id, txHash })

    return {
      mode,
      payload,
      submission: { attempted: true, status: 'success', txHash },
    }
  } catch (err) {
    const appError = AppError.fromContractError(err)
    if (appError) {
      log('error', 'soroban.submit_error_contract', { vaultId: vault.id, code: appError.code, message: appError.message, details: appError.details })
      return {
        mode,
        payload,
        submission: { 
          attempted: true, 
          status: 'error', 
          error: { code: appError.code, message: appError.message, details: appError.details } 
        },
      }
    }

    const message = err instanceof Error ? err.message : 'Unknown submission error'
    log('error', 'soroban.submit_error', { vaultId: vault.id, error: message })

    return {
      mode,
      payload,
      submission: { attempted: true, status: 'error', error: message },
    }
  }
}

/**
 * Submit a stake transaction for a vault.
 * Returns not_configured if Soroban is not fully configured.
 */
export const submitStake = async (
  vaultId: string,
  amount: string,
): Promise<VaultLifecycleResponse> => {
  const config = getSorobanConfig()
  const args = { vaultId, amount }

  if (!config) {
    log('warn', 'soroban.stake_not_configured', { vaultId })
    return {
      method: 'stake',
      args,
      submission: { attempted: true, status: 'not_configured' },
    }
  }

  try {
    log('info', 'soroban.stake_start', { vaultId })
    const { txHash } = await _client.submitStake(config, args)
    log('info', 'soroban.stake_success', { vaultId, txHash })

    return {
      method: 'stake',
      args,
      submission: { attempted: true, status: 'success', txHash },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown stake error'
    log('error', 'soroban.stake_error', { vaultId, error: message })

    return {
      method: 'stake',
      args,
      submission: { attempted: true, status: 'error', error: message },
    }
  }
}

/**
 * Submit a check-in transaction for a vault milestone.
 * Returns not_configured if Soroban is not fully configured.
 */
export const submitCheckIn = async (
  vaultId: string,
  milestoneId: string,
): Promise<VaultLifecycleResponse> => {
  const config = getSorobanConfig()
  const args = { vaultId, milestoneId }

  if (!config) {
    log('warn', 'soroban.check_in_not_configured', { vaultId, milestoneId })
    return {
      method: 'check_in',
      args,
      submission: { attempted: true, status: 'not_configured' },
    }
  }

  try {
    log('info', 'soroban.check_in_start', { vaultId, milestoneId })
    const { txHash } = await _client.submitCheckIn(config, args)
    log('info', 'soroban.check_in_success', { vaultId, milestoneId, txHash })

    return {
      method: 'check_in',
      args,
      submission: { attempted: true, status: 'success', txHash },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown check_in error'
    log('error', 'soroban.check_in_error', { vaultId, milestoneId, error: message })

    return {
      method: 'check_in',
      args,
      submission: { attempted: true, status: 'error', error: message },
    }
  }
}

/**
 * Submit a slash_on_miss transaction for a missed milestone.
 * Returns not_configured if Soroban is not fully configured.
 */
export const submitSlash = async (
  vaultId: string,
  milestoneId: string,
): Promise<VaultLifecycleResponse> => {
  const config = getSorobanConfig()
  const args = { vaultId, milestoneId }

  if (!config) {
    log('warn', 'soroban.slash_not_configured', { vaultId, milestoneId })
    return {
      method: 'slash_on_miss',
      args,
      submission: { attempted: true, status: 'not_configured' },
    }
  }

  try {
    log('info', 'soroban.slash_start', { vaultId, milestoneId })
    const { txHash } = await _client.submitSlash(config, args)
    log('info', 'soroban.slash_success', { vaultId, milestoneId, txHash })

    return {
      method: 'slash_on_miss',
      args,
      submission: { attempted: true, status: 'success', txHash },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown slash error'
    log('error', 'soroban.slash_error', { vaultId, milestoneId, error: message })

    return {
      method: 'slash_on_miss',
      args,
      submission: { attempted: true, status: 'error', error: message },
    }
  }
}

/**
 * Submit a claim transaction for a completed vault.
 * Returns not_configured if Soroban is not fully configured.
 */
export const submitClaim = async (
  vaultId: string,
): Promise<VaultLifecycleResponse> => {
  const config = getSorobanConfig()
  const args = { vaultId }

  if (!config) {
    log('warn', 'soroban.claim_not_configured', { vaultId })
    return {
      method: 'claim',
      args,
      submission: { attempted: true, status: 'not_configured' },
    }
  }

  try {
    log('info', 'soroban.claim_start', { vaultId })
    const { txHash } = await _client.submitClaim(config, args)
    log('info', 'soroban.claim_success', { vaultId, txHash })

    return {
      method: 'claim',
      args,
      submission: { attempted: true, status: 'success', txHash },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown claim error'
    log('error', 'soroban.claim_error', { vaultId, error: message })

    return {
      method: 'claim',
      args,
      submission: { attempted: true, status: 'error', error: message },
    }
  }
}

/**
 * Submit a withdraw transaction to withdraw remaining funds.
 * Returns not_configured if Soroban is not fully configured.
 */
export const submitWithdraw = async (
  vaultId: string,
): Promise<VaultLifecycleResponse> => {
  const config = getSorobanConfig()
  const args = { vaultId }

  if (!config) {
    log('warn', 'soroban.withdraw_not_configured', { vaultId })
    return {
      method: 'withdraw',
      args,
      submission: { attempted: true, status: 'not_configured' },
    }
  }

  try {
    log('info', 'soroban.withdraw_start', { vaultId })
    const { txHash } = await _client.submitWithdraw(config, args)
    log('info', 'soroban.withdraw_success', { vaultId, txHash })

    return {
      method: 'withdraw',
      args,
      submission: { attempted: true, status: 'success', txHash },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown withdraw error'
    log('error', 'soroban.withdraw_error', { vaultId, error: message })

    return {
      method: 'withdraw',
      args,
      submission: { attempted: true, status: 'error', error: message },
    }
  }
}
// ─── Slash-on-miss payload builder ──────────────────────────────────────────

/**
 * Builds the on-chain payload descriptor for the slash_on_miss contract call.
 * Does NOT submit a real Soroban transaction; submission is gated behind
 * environment configuration the same way as buildVaultCreationPayload.
 * Status is always 'not_configured' until a real submit path is wired.
 */
export const buildSlashOnMissPayload = (vaultId: string) => {
  return {
    mode: 'submit' as const,
    payload: {
      contractId: process.env.SOROBAN_CONTRACT_ID ?? DEFAULT_CONTRACT_ID,
      networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
      sourceAccount: process.env.SOROBAN_SOURCE_ACCOUNT ?? DEFAULT_SOURCE_ACCOUNT,
      method: 'slash_on_miss',
      args: { vaultId },
    },
    submission: {
      attempted: true,
      status: 'not_configured' as const,
    },
  }
}

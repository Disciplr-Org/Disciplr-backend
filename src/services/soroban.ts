import type { CreateVaultInput, PersistedVault, VaultCreateResponse } from '../types/vaults.js'

const DEFAULT_CONTRACT_ID = 'CONTRACT_ID_NOT_CONFIGURED'
const DEFAULT_SOURCE_ACCOUNT = 'SOURCE_ACCOUNT_NOT_CONFIGURED'

// ─── Soroban configuration resolved from env ────────────────────────────────

export interface SorobanConfig {
  contractId: string
  networkPassphrase: string
  sourceAccount: string
  rpcUrl: string
  secretKey: string
}

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

  return { contractId, networkPassphrase, sourceAccount, rpcUrl, secretKey }
}

/**
 * Whether the backend is configured to submit Soroban transactions.
 * Useful for health checks and observability.
 */
export const isSorobanSubmitEnabled = (): boolean => getSorobanConfig() !== null

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
}

/**
 * Default production client that calls the real Stellar SDK.
 * Imported lazily so the module loads even when @stellar/stellar-sdk
 * is not fully configured (e.g. in unit test environments).
 */
export const defaultSorobanClient: SorobanClient = {
  async submitVaultCreation(config, args) {
    // Dynamic import keeps the top-level module lightweight and avoids
    // breaking test suites that never exercise real submission.
    const {
      Keypair,
      Contract,
      SorobanRpc,
      Networks,
      TransactionBuilder,
      nativeToScVal,
      BASE_FEE,
    } = await import('@stellar/stellar-sdk')

    const server = new SorobanRpc.Server(config.rpcUrl)
    const keypair = Keypair.fromSecret(config.secretKey)
    const account = await server.getAccount(config.sourceAccount)

    const contract = new Contract(config.contractId)
    const callOp = contract.call(
      'create_vault',
      nativeToScVal(args.vaultId, { type: 'string' }),
      nativeToScVal(args.amount, { type: 'string' }),
      nativeToScVal(args.verifier, { type: 'string' }),
      nativeToScVal(args.successDestination, { type: 'string' }),
      nativeToScVal(args.failureDestination, { type: 'string' }),
    )

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

    // Poll for completion
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
  },
}

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

  // ── build mode: return signing payload for the client ────────────
  if (mode !== 'submit') {
    return {
      mode,
      payload,
      submission: { attempted: false, status: 'not_requested' },
    }
  }

  // ── submit mode: check feature flag ──────────────────────────────
  const config = getSorobanConfig()
  if (!config) {
    log('warn', 'soroban.submit_not_configured', { vaultId: vault.id })
    return {
      mode,
      payload,
      submission: { attempted: true, status: 'not_configured' },
    }
  }

  // ── submit mode: real submission ─────────────────────────────────
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
    const message = err instanceof Error ? err.message : 'Unknown submission error'
    log('error', 'soroban.submit_error', { vaultId: vault.id, error: message })

    return {
      mode,
      payload,
      submission: { attempted: true, status: 'error', error: message },
    }
  }
}

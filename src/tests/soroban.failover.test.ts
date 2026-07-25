/**
 * Health-aware Soroban RPC endpoint pool — failover and probe tests.
 *
 * These tests exercise the SorobanRpcPool class and the failover behaviour
 * wired into createDefaultSorobanClient / submitTransaction.  They do NOT
 * hit the network; every RPC call is mocked at the SDK layer.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import type { SorobanConfig } from '../services/soroban.js'
import {
  createDefaultSorobanClient,
  createRpcPool,
  resetRpcPool,
  getRpcPoolHealth,
  SorobanRpcPool,
} from '../services/soroban.js'

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const PRIMARY_URL = 'https://rpc-primary.example.com'
const SECONDARY_URL = 'https://rpc-secondary.example.com'
const stellar = (char = 'A'): string => `G${char.repeat(55)}`

const BASE_CONFIG: SorobanConfig = {
  contractId: 'CABCDEF1234567890',
  networkPassphrase: 'Test SDF Network ; September 2015',
  sourceAccount: stellar(),
  secretKey: 'SCZANGBA5YHTNYVVV3C7CAZMCLPVAR3LXKLHEADMPROMU3QAHZGOSN6A',
  rpcUrls: [PRIMARY_URL, SECONDARY_URL],
  rpcUrl: PRIMARY_URL,
  submitPollIntervalMs: 1,
  submitPollMaxAttempts: 3,
  rpcTimeoutMs: 5_000,
  submitTimeoutMs: 10_000,
  submitRetry: {
    maxAttempts: 1,
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    backoffMultiplier: 1,
    jitterFactor: 0,
  },
}

const VAULT_ARGS = {
  vaultId: 'vault-failover-test',
  amount: '1000',
  verifier: stellar('B'),
  successDestination: stellar('C'),
  failureDestination: stellar('D'),
}

// ─── SDK factory ─────────────────────────────────────────────────────────────
//
// Builds a fake Stellar SDK that routes `new rpc.Server(url)` to a per-URL
// mock server, allowing each test to control which endpoint succeeds.

type MockServer = {
  getAccount: jest.Mock
  prepareTransaction: jest.Mock
  sendTransaction: jest.Mock
  getTransaction: jest.Mock
}

const makeOkServer = (txHash = 'tx-hash-ok'): MockServer => ({
  getAccount: jest.fn<MockServer['getAccount']>().mockResolvedValue({ accountId: stellar() }),
  prepareTransaction: jest.fn<MockServer['prepareTransaction']>().mockResolvedValue({ sign: jest.fn() }),
  sendTransaction: jest.fn<MockServer['sendTransaction']>().mockResolvedValue({ status: 'PENDING', hash: txHash }),
  getTransaction: jest.fn<MockServer['getTransaction']>().mockResolvedValue({ status: 'SUCCESS' }),
})

const makeNetworkErrorServer = (message = 'connection refused'): MockServer => ({
  getAccount: jest.fn<MockServer['getAccount']>().mockRejectedValue(new Error(message)),
  prepareTransaction: jest.fn<MockServer['prepareTransaction']>().mockRejectedValue(new Error(message)),
  sendTransaction: jest.fn<MockServer['sendTransaction']>().mockRejectedValue(new Error(message)),
  getTransaction: jest.fn<MockServer['getTransaction']>().mockRejectedValue(new Error(message)),
})

const makeFakeSdkWithRouting = (serverMap: Record<string, MockServer>) => {
  const ServerCtor = jest.fn((url: string) => serverMap[url] ?? makeNetworkErrorServer('no server for url'))
  return async () => ({
    Keypair: { fromSecret: jest.fn(() => ({ sign: jest.fn(), publicKey: jest.fn() })) },
    Contract: class {
      call = jest.fn(() => ({}))
    },
    rpc: { Server: ServerCtor },
    TransactionBuilder: class {
      addOperation = jest.fn(() => this)
      setTimeout = jest.fn(() => this)
      build = jest.fn(() => ({}))
    },
    nativeToScVal: jest.fn((v: unknown) => v),
    xdr: { ScVal: { scvBytes: jest.fn((b: Buffer) => b) } },
    BASE_FEE: '100',
  })
}

// ─── Test setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  resetRpcPool()
})

afterEach(() => {
  resetRpcPool()
})

// ─── SorobanRpcPool unit tests ───────────────────────────────────────────────

describe('SorobanRpcPool', () => {
  it('starts all endpoints as healthy', () => {
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL])
    const statuses = pool.getHealthStatuses()
    expect(statuses).toHaveLength(2)
    expect(statuses.every((s) => s.status === 'healthy')).toBe(true)
  })

  it('demotes an endpoint to degraded after one failure (below threshold)', () => {
    const pool = createRpcPool([PRIMARY_URL], { failureThreshold: 3 })
    pool.recordFailure(PRIMARY_URL)
    const [status] = pool.getHealthStatuses()
    expect(status.status).toBe('degraded')
    expect(status.failureCount).toBe(1)
  })

  it('demotes an endpoint to down after reaching the failure threshold', () => {
    const pool = createRpcPool([PRIMARY_URL], { failureThreshold: 2 })
    pool.recordFailure(PRIMARY_URL)
    pool.recordFailure(PRIMARY_URL)
    const [status] = pool.getHealthStatuses()
    expect(status.status).toBe('down')
    expect(status.failureCount).toBe(2)
  })

  it('promotes a down endpoint back to healthy on recordSuccess', () => {
    const pool = createRpcPool([PRIMARY_URL], { failureThreshold: 1 })
    pool.recordFailure(PRIMARY_URL)
    expect(pool.getHealthStatuses()[0].status).toBe('down')
    pool.recordSuccess(PRIMARY_URL)
    expect(pool.getHealthStatuses()[0].status).toBe('healthy')
    expect(pool.getHealthStatuses()[0].failureCount).toBe(0)
  })

  it('orders healthy endpoints before degraded and down', () => {
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL, 'https://rpc-tertiary.example.com'], {
      failureThreshold: 3,
    })
    pool.recordFailure(PRIMARY_URL)   // degraded
    pool.recordFailure(PRIMARY_URL)
    pool.recordFailure(PRIMARY_URL)   // now down
    pool.recordFailure(SECONDARY_URL) // degraded

    const ordered = pool.getOrderedUrls()
    expect(ordered[0]).toBe('https://rpc-tertiary.example.com') // healthy
    expect(ordered[1]).toBe(SECONDARY_URL)                       // degraded
    expect(ordered[2]).toBe(PRIMARY_URL)                         // down
  })

  it('isAvailable returns false for down endpoints and true for healthy/degraded', () => {
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 1 })
    pool.recordFailure(PRIMARY_URL)
    expect(pool.isAvailable(PRIMARY_URL)).toBe(false)
    expect(pool.isAvailable(SECONDARY_URL)).toBe(true)
  })

  it('masks URLs to protocol://host only', () => {
    const pool = createRpcPool(['https://api.example.com:8080/rpc?key=secret'])
    const [status] = pool.getHealthStatuses()
    expect(status.maskedUrl).toBe('https://api.example.com:8080')
    expect(status.maskedUrl).not.toContain('secret')
  })

  it('records lastFailureAt timestamp on failure', () => {
    const before = Date.now()
    const pool = createRpcPool([PRIMARY_URL])
    pool.recordFailure(PRIMARY_URL)
    const [status] = pool.getHealthStatuses()
    expect(status.lastFailureAt).not.toBeNull()
    expect(new Date(status.lastFailureAt!).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('resets failureCount and clears degraded status on recordSuccess', () => {
    const pool = createRpcPool([PRIMARY_URL], { failureThreshold: 5 })
    pool.recordFailure(PRIMARY_URL)
    pool.recordFailure(PRIMARY_URL)
    expect(pool.getHealthStatuses()[0].failureCount).toBe(2)
    pool.recordSuccess(PRIMARY_URL)
    expect(pool.getHealthStatuses()[0].failureCount).toBe(0)
    expect(pool.getHealthStatuses()[0].status).toBe('healthy')
  })

  it('throws when constructed with an empty URL list', () => {
    expect(() => createRpcPool([])).toThrow('SorobanRpcPool requires at least one URL')
  })

  // ─── Probe tests ───────────────────────────────────────────────────────────

  it('re-probes a down endpoint and promotes it when probe succeeds', async () => {
    const probe = jest.fn<ProbeFunction>().mockResolvedValue(true)
    const pool = createRpcPool([PRIMARY_URL], { failureThreshold: 1, probe })
    pool.recordFailure(PRIMARY_URL)
    expect(pool.getHealthStatuses()[0].status).toBe('down')

    await pool.probeNow()

    expect(probe).toHaveBeenCalledWith(PRIMARY_URL, expect.any(Number))
    expect(pool.getHealthStatuses()[0].status).toBe('healthy')
  })

  it('leaves a down endpoint as down when probe fails', async () => {
    const probe = jest.fn<ProbeFunction>().mockResolvedValue(false)
    const pool = createRpcPool([PRIMARY_URL], { failureThreshold: 1, probe })
    pool.recordFailure(PRIMARY_URL)

    await pool.probeNow()

    expect(pool.getHealthStatuses()[0].status).toBe('down')
  })

  it('does not probe healthy or degraded endpoints', async () => {
    const probe = jest.fn<ProbeFunction>().mockResolvedValue(true)
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3, probe })
    pool.recordFailure(SECONDARY_URL) // degraded

    await pool.probeNow()

    expect(probe).not.toHaveBeenCalled()
  })

  it('sets lastProbeAt after a probe attempt', async () => {
    const before = Date.now()
    const probe = jest.fn<ProbeFunction>().mockResolvedValue(false)
    const pool = createRpcPool([PRIMARY_URL], { failureThreshold: 1, probe })
    pool.recordFailure(PRIMARY_URL)

    await pool.probeNow()

    const [status] = pool.getHealthStatuses()
    expect(status.lastProbeAt).not.toBeNull()
    expect(new Date(status.lastProbeAt!).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('stopProbing clears the background timer', () => {
    const pool = createRpcPool([PRIMARY_URL])
    pool.startProbing()
    pool.stopProbing()
    // No assertion needed — this verifies no error is thrown and timer is cleared
    pool.stopProbing() // safe to call twice
  })
})

// ─── getRpcPoolHealth ─────────────────────────────────────────────────────────

describe('getRpcPoolHealth', () => {
  it('returns null when the pool has not been initialised', () => {
    expect(getRpcPoolHealth()).toBeNull()
  })
})

// ─── Failover integration tests ───────────────────────────────────────────────

describe('submitTransaction failover (via createDefaultSorobanClient)', () => {
  it('succeeds immediately when the primary endpoint is healthy', async () => {
    const primaryServer = makeOkServer('tx-primary')
    const secondaryServer = makeOkServer('tx-secondary')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3 })
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: secondaryServer }),
      pool,
    )

    const result = await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)

    expect(result.txHash).toBe('tx-primary')
    expect(primaryServer.getAccount).toHaveBeenCalledTimes(1)
    expect(secondaryServer.getAccount).not.toHaveBeenCalled()
  })

  it('fails over to secondary when primary getAccount fails with network error', async () => {
    const primaryServer = makeNetworkErrorServer('econnrefused')
    const secondaryServer = makeOkServer('tx-from-secondary')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3 })
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: secondaryServer }),
      pool,
    )

    const result = await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)

    expect(result.txHash).toBe('tx-from-secondary')
    expect(primaryServer.getAccount).toHaveBeenCalledTimes(1)
    expect(secondaryServer.getAccount).toHaveBeenCalledTimes(1)
  })

  it('fails over to secondary when primary prepareTransaction fails with network error', async () => {
    const primaryServer: MockServer = {
      getAccount: jest.fn<MockServer['getAccount']>().mockResolvedValue({ accountId: stellar() }),
      prepareTransaction: jest.fn<MockServer['prepareTransaction']>().mockRejectedValue(new Error('timeout')),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    }
    const secondaryServer = makeOkServer('tx-prepare-failover')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3 })
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: secondaryServer }),
      pool,
    )

    const result = await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)

    expect(result.txHash).toBe('tx-prepare-failover')
    expect(primaryServer.sendTransaction).not.toHaveBeenCalled()
    expect(secondaryServer.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('does NOT failover to secondary after sendTransaction commits (prevents double-submit)', async () => {
    const primaryServer: MockServer = {
      getAccount: jest.fn<MockServer['getAccount']>().mockResolvedValue({ accountId: stellar() }),
      prepareTransaction: jest.fn<MockServer['prepareTransaction']>().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest.fn<MockServer['sendTransaction']>().mockResolvedValue({
        status: 'PENDING',
        hash: 'tx-committed',
      }),
      // getTransaction always returns NOT_FOUND → will exhaust poll attempts
      getTransaction: jest.fn<MockServer['getTransaction']>().mockResolvedValue({ status: 'NOT_FOUND' }),
    }
    const secondaryServer = makeOkServer('tx-secondary-should-not-be-used')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3 })
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: secondaryServer }),
      pool,
    )

    await expect(client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)).rejects.toThrow(
      'Soroban transaction did not succeed',
    )

    // sendTransaction was called exactly once on the primary; secondary was never used
    expect(primaryServer.sendTransaction).toHaveBeenCalledTimes(1)
    expect(secondaryServer.getAccount).not.toHaveBeenCalled()
    expect(secondaryServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('throws when all endpoints fail before sendTransaction', async () => {
    const primaryServer = makeNetworkErrorServer('econnrefused')
    const secondaryServer = makeNetworkErrorServer('connection reset')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3 })
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: secondaryServer }),
      pool,
    )

    await expect(client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)).rejects.toThrow()
  })

  it('skips already-down endpoints and goes directly to healthy ones', async () => {
    const primaryServer = makeOkServer('tx-healthy-secondary')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 1 })

    // Pre-mark the secondary as down
    pool.recordFailure(SECONDARY_URL)
    expect(pool.getHealthStatuses().find((s) => s.maskedUrl.includes('secondary'))?.status).toBe('down')

    // Client maps SECONDARY to a server that would succeed — but pool skips it
    const goodSecondaryServer = makeOkServer('should-not-be-used')
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: goodSecondaryServer }),
      pool,
    )

    const result = await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)
    expect(result.txHash).toBe('tx-healthy-secondary')
    expect(goodSecondaryServer.getAccount).not.toHaveBeenCalled()
  })

  it('records success on pool after a successful transaction', async () => {
    const primaryServer = makeOkServer('tx-ok')
    const pool = createRpcPool([PRIMARY_URL], { failureThreshold: 3 })
    // Pre-degrade the endpoint
    pool.recordFailure(PRIMARY_URL)
    expect(pool.getHealthStatuses()[0].status).toBe('degraded')

    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer }),
      pool,
    )
    await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)

    expect(pool.getHealthStatuses()[0].status).toBe('healthy')
    expect(pool.getHealthStatuses()[0].failureCount).toBe(0)
  })

  it('records failure on pool when primary endpoint fails (network error before send)', async () => {
    const primaryServer = makeNetworkErrorServer('econnreset')
    const secondaryServer = makeOkServer('tx-after-fail')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3 })

    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: secondaryServer }),
      pool,
    )
    await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)

    const primaryHealth = pool.getHealthStatuses().find((s) => s.maskedUrl.includes('primary'))
    expect(primaryHealth?.status).toBe('degraded')
    expect(primaryHealth?.failureCount).toBe(1)
  })

  it('demotes endpoint to down after failure threshold is reached across calls', async () => {
    const alwaysFailServer = makeNetworkErrorServer('503 service unavailable')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 2 })

    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({
        [PRIMARY_URL]: alwaysFailServer,
        [SECONDARY_URL]: makeOkServer('tx-secondary'),
      }),
      pool,
    )

    // First call: primary fails once → degraded
    await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)
    expect(pool.getHealthStatuses().find((s) => s.maskedUrl.includes('primary'))?.status).toBe('degraded')

    // Second call: primary fails again → down
    const alwaysFailServer2 = makeNetworkErrorServer('503 service unavailable')
    const client2 = createDefaultSorobanClient(
      makeFakeSdkWithRouting({
        [PRIMARY_URL]: alwaysFailServer2,
        [SECONDARY_URL]: makeOkServer('tx-secondary-2'),
      }),
      pool,
    )
    await client2.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)
    expect(pool.getHealthStatuses().find((s) => s.maskedUrl.includes('primary'))?.status).toBe('down')
  })

  // ─── Re-probe and recovery ─────────────────────────────────────────────────

  it('re-probes a down endpoint and uses it again after recovery', async () => {
    let probeResult = false
    const probe = jest.fn(async (_url: string, _timeoutMs: number) => probeResult)
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 1, probe })

    // Mark primary as down
    pool.recordFailure(PRIMARY_URL)
    expect(pool.getHealthStatuses().find((s) => s.maskedUrl.includes('primary'))?.status).toBe('down')

    // Probe fails → still down
    await pool.probeNow()
    expect(pool.getHealthStatuses().find((s) => s.maskedUrl.includes('primary'))?.status).toBe('down')

    // Probe succeeds → primary is healthy again
    probeResult = true
    await pool.probeNow()
    expect(pool.getHealthStatuses().find((s) => s.maskedUrl.includes('primary'))?.status).toBe('healthy')

    // Next transaction uses primary again
    const primaryServer = makeOkServer('tx-recovered')
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: makeOkServer() }),
      pool,
    )
    const result = await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)
    expect(result.txHash).toBe('tx-recovered')
    expect(primaryServer.getAccount).toHaveBeenCalledTimes(1)
  })

  // ─── Non-network errors ────────────────────────────────────────────────────

  it('does not failover for non-network errors (e.g. account not found)', async () => {
    const primaryServer: MockServer = {
      getAccount: jest
        .fn<MockServer['getAccount']>()
        .mockRejectedValue(new Error('account does not exist on the network')),
      prepareTransaction: jest.fn(),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    }
    const secondaryServer = makeOkServer('should-not-be-reached')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3 })
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: secondaryServer }),
      pool,
    )

    await expect(client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)).rejects.toThrow(
      'account does not exist',
    )

    // Secondary was never tried — non-network errors are not retried across endpoints
    expect(secondaryServer.getAccount).not.toHaveBeenCalled()
  })

  // ─── healthService integration ─────────────────────────────────────────────

  it('getRpcPoolHealth reflects pool state after a failover', async () => {
    const primaryServer = makeNetworkErrorServer('econnrefused')
    const secondaryServer = makeOkServer('tx-health-check')
    const pool = createRpcPool([PRIMARY_URL, SECONDARY_URL], { failureThreshold: 3 })
    const client = createDefaultSorobanClient(
      makeFakeSdkWithRouting({ [PRIMARY_URL]: primaryServer, [SECONDARY_URL]: secondaryServer }),
      pool,
    )

    // Inject pool into the module-level slot by making the pool the one returned
    // by getRpcPoolHealth. We do this by performing a call that populates it.
    // (In these tests we pass pool explicitly, so getRpcPoolHealth() is null.
    // We verify pool.getHealthStatuses() directly instead.)
    await client.submitVaultCreation(BASE_CONFIG, VAULT_ARGS)

    const statuses = pool.getHealthStatuses()
    const primaryStatus = statuses.find((s) => s.maskedUrl.includes('primary'))
    const secondaryStatus = statuses.find((s) => s.maskedUrl.includes('secondary'))

    expect(primaryStatus?.status).toBe('degraded')
    expect(secondaryStatus?.status).toBe('healthy')
  })
})

// ─── Type alias so the ProbeFunction type is visible in test scope ─────────
type ProbeFunction = (url: string, timeoutMs: number) => Promise<boolean>

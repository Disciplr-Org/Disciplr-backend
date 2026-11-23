/**
 * Alert-threshold and stateless-alert tests for src/services/monitor.ts
 *
 * Cross-reference: docs/runbooks/on-call-slo.md — defines operational SLO targets:
 *   • Listener lag warning  : lag > 30 ledgers for > 5 minutes
 *   • Listener lag critical : lag > 120 ledgers for > 2 minutes
 *
 * Threshold logic uses a strict ">" comparison with lagThreshold from validated config.
 * There is intentionally NO hysteresis/debounce state — each checkListenerLag() call
 * evaluates the threshold independently.  The "stateless alert" tests document and verify
 * this behaviour so any future accidental introduction of latching is caught.
 *
 * Test areas:
 *   1. getLatestListenerLag accessor  — initial state, post-check value, error retention
 *   2. Threshold-crossing behaviour   — warn / no-warn / recovery
 *   3. Exact boundary behaviour       — strict ">" not ">="
 *   4. Stateless alerts               — no hysteresis; each check is independent
 *   5. Config-driven thresholds       — different lagThreshold values are respected
 *   6. Error and edge-case handling   — Horizon failures, empty records, DB errors
 *   7. Monitor lifecycle              — start/stop, callback behaviour, guard against double-start
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockLedgerCall = jest.fn<any>()
const mockServer = {
  ledgers: jest.fn<any>().mockReturnThis(),
  order:   jest.fn<any>().mockReturnThis(),
  limit:   jest.fn<any>().mockReturnThis(),
  call:    mockLedgerCall,
}
const MockServerClass = jest.fn<any>(() => mockServer)

jest.unstable_mockModule('@stellar/stellar-sdk', () => ({
  Horizon: { Server: MockServerClass },
  default: {},
}))

const mockDbChain = {
  where: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>(),
}
const mockDb = jest.fn<any>(() => mockDbChain)

jest.unstable_mockModule('../db/knex.js', () => ({ db: mockDb }))

const mockGetValidatedConfig = jest.fn<any>()
jest.unstable_mockModule('../config/horizonListener.js', () => ({
  getValidatedConfig: mockGetValidatedConfig,
}))

const mockMarkVaultExpiries = jest.fn<any>()
jest.unstable_mockModule('../services/vaultExpiry.service.js', () => ({
  markVaultExpiries: mockMarkVaultExpiries,
}))

// ─── Subject under test ───────────────────────────────────────────────────────

const {
  checkListenerLag,
  getLatestListenerLag,
  startDeadlineMonitor,
  stopDeadlineMonitor,
} = await import('../services/monitor.js')

// ─── Shared constants ─────────────────────────────────────────────────────────

const BASE_CONFIG = {
  horizonUrl:        'https://horizon-testnet.stellar.org',
  lagThreshold:      10,
  startLedger:       100,
  contractAddresses: ['CTEST123'],
  retryMaxAttempts:  3,
  retryBackoffMs:    100,
  shutdownTimeoutMs: 30000,
}

/** Resets the Horizon chain mocks to their default working state. */
function resetHorizonChain(latestSequence = 105, lastProcessed = 100) {
  mockServer.ledgers.mockReset()
  mockServer.order.mockReset()
  mockServer.limit.mockReset()
  mockServer.ledgers.mockReturnThis()
  mockServer.order.mockReturnThis()
  mockServer.limit.mockReturnThis()
  mockLedgerCall.mockResolvedValue({ records: [{ sequence: latestSequence }] })
  mockDbChain.first.mockResolvedValue({ last_processed_ledger: lastProcessed })
}

// ─── 1. getLatestListenerLag ──────────────────────────────────────────────────

describe('getLatestListenerLag', () => {
  let consoleWarnSpy: any
  let consoleErrorSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    resetHorizonChain()
    consoleWarnSpy  = jest.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG })
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  // MUST be the first test executed so the module-level _latestLag is still undefined.
  it('returns undefined before any measurement has been taken', () => {
    expect(getLatestListenerLag()).toBeUndefined()
  })

  it('returns the computed lag after a successful checkListenerLag call', async () => {
    resetHorizonChain(200, 190)
    await checkListenerLag()
    expect(getLatestListenerLag()).toBe(10)
  })

  it('reflects the most recent measurement after multiple calls', async () => {
    resetHorizonChain(300, 250)
    await checkListenerLag()
    expect(getLatestListenerLag()).toBe(50)

    resetHorizonChain(310, 309)
    await checkListenerLag()
    expect(getLatestListenerLag()).toBe(1)
  })

  it('retains the previous lag value when Horizon throws an error', async () => {
    resetHorizonChain(150, 140)
    await checkListenerLag()
    const priorLag = getLatestListenerLag()

    mockServer.ledgers.mockImplementationOnce(() => { throw new Error('Connection refused') })
    await checkListenerLag()

    expect(getLatestListenerLag()).toBe(priorLag)
  })

  it('retains the previous lag value when Horizon returns no ledger records', async () => {
    resetHorizonChain(160, 155)
    await checkListenerLag()
    const priorLag = getLatestListenerLag()

    mockLedgerCall.mockResolvedValueOnce({ records: [] })
    await checkListenerLag()

    expect(getLatestListenerLag()).toBe(priorLag)
  })
})

// ─── 2. Threshold-crossing behaviour ─────────────────────────────────────────

describe('checkListenerLag — threshold-crossing behaviour', () => {
  let consoleWarnSpy: any
  let consoleErrorSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    resetHorizonChain()
    consoleWarnSpy  = jest.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 10 })
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('fires a warning when lag strictly exceeds lagThreshold', async () => {
    resetHorizonChain(120, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Horizon listener lag detected: 20 ledgers')
    )
  })

  it('includes the threshold value in the alert message', async () => {
    resetHorizonChain(115, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Threshold: 10')
    )
  })

  it('includes ledger positions in the secondary alert message', async () => {
    resetHorizonChain(130, 100)
    await checkListenerLag()
    const calls = consoleWarnSpy.mock.calls.flat().join(' ')
    expect(calls).toContain('130')
    expect(calls).toContain('100')
  })

  it('does not warn when lag is below lagThreshold', async () => {
    resetHorizonChain(109, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('clears alert (no warning) when lag recovers below threshold after a prior breach', async () => {
    resetHorizonChain(120, 100)
    await checkListenerLag()
    consoleWarnSpy.mockClear()

    resetHorizonChain(105, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when lagThreshold is undefined (disabled)', async () => {
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: undefined })
    resetHorizonChain(999, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('uses startLedger from config as baseline when no DB state exists', async () => {
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, startLedger: 50, lagThreshold: 10 })
    mockLedgerCall.mockResolvedValue({ records: [{ sequence: 80 }] })
    mockDbChain.first.mockResolvedValue(null)
    await checkListenerLag()
    // lag = 80 - 50 = 30 > 10 → alert
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Horizon listener lag detected: 30 ledgers')
    )
  })

  it('uses 0 as baseline when neither DB state nor startLedger exist', async () => {
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, startLedger: undefined, lagThreshold: 10 })
    mockLedgerCall.mockResolvedValue({ records: [{ sequence: 15 }] })
    mockDbChain.first.mockResolvedValue(null)
    await checkListenerLag()
    // lag = 15 - 0 = 15 > 10 → alert
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Horizon listener lag detected: 15 ledgers')
    )
  })
})

// ─── 3. Exact boundary behaviour ─────────────────────────────────────────────
//
// The comparison is strictly "lag > lagThreshold" — not ">=".
// A lag exactly equal to the threshold must NOT trigger a warning.

describe('checkListenerLag — exact boundary behaviour', () => {
  let consoleWarnSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    resetHorizonChain()
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 10 })
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
  })

  it('does not warn when lag equals lagThreshold exactly (strict >)', async () => {
    resetHorizonChain(110, 100) // lag = 10, threshold = 10 → no warn
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('warns when lag is exactly one ledger above lagThreshold', async () => {
    resetHorizonChain(111, 100) // lag = 11, threshold = 10 → warn
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Horizon listener lag detected: 11 ledgers')
    )
  })

  it('does not warn when lag is exactly one ledger below lagThreshold', async () => {
    resetHorizonChain(109, 100) // lag = 9, threshold = 10 → no warn
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when lag is zero (latest ledger equals last processed)', async () => {
    resetHorizonChain(100, 100) // lag = 0
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('warns on any positive lag when lagThreshold is zero', async () => {
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 0 })
    resetHorizonChain(101, 100) // lag = 1, threshold = 0 → warn
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Horizon listener lag detected: 1 ledgers')
    )
  })

  it('does not warn on zero lag when lagThreshold is zero', async () => {
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 0 })
    resetHorizonChain(100, 100) // lag = 0, threshold = 0 → no warn (not strictly >)
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })
})

// ─── 4. Stateless alert behaviour (no hysteresis) ────────────────────────────
//
// The monitor evaluates the threshold on every call without any debounce state.
// Tests here document that behaviour — each crossing on every check produces a
// warning, and recovering below the threshold immediately suppresses them.

describe('checkListenerLag — stateless alert behaviour (no hysteresis)', () => {
  let consoleWarnSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    resetHorizonChain()
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 10 })
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
  })

  it('produces a warning on every successive check while lag remains above threshold', async () => {
    resetHorizonChain(120, 100) // lag = 20 on every call
    await checkListenerLag()
    await checkListenerLag()
    await checkListenerLag()

    const lagWarnings = consoleWarnSpy.mock.calls.filter((args: any[]) =>
      String(args[0]).includes('lag detected')
    )
    expect(lagWarnings).toHaveLength(3)
  })

  it('never warns on any check when lag remains below threshold throughout', async () => {
    resetHorizonChain(105, 100) // lag = 5
    await checkListenerLag()
    await checkListenerLag()
    await checkListenerLag()

    const lagWarnings = consoleWarnSpy.mock.calls.filter((args: any[]) =>
      String(args[0]).includes('lag detected')
    )
    expect(lagWarnings).toHaveLength(0)
  })

  it('alternates between warning and no-warning as lag toggles across threshold', async () => {
    // Breach (lag = 20)
    resetHorizonChain(120, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('lag detected'))
    consoleWarnSpy.mockClear()

    // Recovery (lag = 5)
    resetHorizonChain(105, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()

    // Breach again (lag = 15)
    resetHorizonChain(115, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('lag detected'))
  })

  it('rapid successive crossings each independently produce a warning (no debounce)', async () => {
    const scenarios = [
      { seq: 120, last: 100 }, // lag 20 → warn
      { seq: 105, last: 100 }, // lag 5  → no warn
      { seq: 115, last: 100 }, // lag 15 → warn
      { seq: 108, last: 100 }, // lag 8  → no warn
      { seq: 111, last: 100 }, // lag 11 → warn
    ]

    for (const { seq, last } of scenarios) {
      resetHorizonChain(seq, last)
      await checkListenerLag()
    }

    const lagWarnings = consoleWarnSpy.mock.calls.filter((args: any[]) =>
      String(args[0]).includes('lag detected')
    )
    // Breaches at indices 0, 2, 4 → 3 warnings
    expect(lagWarnings).toHaveLength(3)
  })
})

// ─── 5. Config-driven threshold values ───────────────────────────────────────

describe('checkListenerLag — config-driven threshold values', () => {
  let consoleWarnSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    resetHorizonChain()
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
  })

  it('applies the SLO warning threshold of 30 ledgers correctly (runbook SLO 3)', async () => {
    // See docs/runbooks/on-call-slo.md — SLO 3: Listener Lag, warning threshold > 30
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 30 })
    resetHorizonChain(131, 100) // lag = 31 > 30 → warn
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('lag detected: 31 ledgers')
    )
  })

  it('does not warn when lag equals the SLO warning threshold of 30 exactly', async () => {
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 30 })
    resetHorizonChain(130, 100) // lag = 30, not strictly > 30
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('applies the SLO critical threshold of 120 ledgers correctly (runbook SLO 3)', async () => {
    // See docs/runbooks/on-call-slo.md — SLO 3: Listener Lag, critical threshold > 120
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 120 })
    resetHorizonChain(221, 100) // lag = 121 > 120 → warn
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('lag detected: 121 ledgers')
    )
  })

  it('re-reads config on every call so threshold changes apply immediately', async () => {
    // Low threshold — lag of 7 breaches
    mockGetValidatedConfig.mockReturnValueOnce({ ...BASE_CONFIG, lagThreshold: 5 })
    resetHorizonChain(107, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('lag detected: 7 ledgers')
    )
    consoleWarnSpy.mockClear()

    // Higher threshold — same lag no longer breaches
    mockGetValidatedConfig.mockReturnValueOnce({ ...BASE_CONFIG, lagThreshold: 50 })
    resetHorizonChain(107, 100)
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('handles a very large threshold without warning for normal lag values', async () => {
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 10000 })
    resetHorizonChain(5100, 100) // lag = 5000, well below 10000
    await checkListenerLag()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })
})

// ─── 6. Error and edge-case handling ─────────────────────────────────────────

describe('checkListenerLag — error and edge-case handling', () => {
  let consoleWarnSpy: any
  let consoleErrorSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    resetHorizonChain() // explicit chain reset prevents leakage from prior tests
    consoleWarnSpy  = jest.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG })
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('logs an error and resolves without throwing when Horizon call fails', async () => {
    // Use mockImplementationOnce to avoid leaking the throwing impl to subsequent tests
    mockServer.ledgers.mockImplementationOnce(() => { throw new Error('Horizon unreachable') })

    await expect(checkListenerLag()).resolves.not.toThrow()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking listener lag:'),
      expect.any(Error)
    )
  })

  it('logs a warning and returns early when Horizon returns an empty records array', async () => {
    mockLedgerCall.mockResolvedValueOnce({ records: [] })

    await checkListenerLag()

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not fetch latest ledger')
    )
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('logs an error and resolves without throwing when the DB query fails', async () => {
    mockDbChain.first.mockRejectedValueOnce(new Error('DB connection lost'))

    await expect(checkListenerLag()).resolves.not.toThrow()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking listener lag:'),
      expect.any(Error)
    )
  })
})

// ─── 7. Monitor lifecycle ─────────────────────────────────────────────────────
//
// startDeadlineMonitor calls setInterval; tests capture the callback via a spy
// and invoke it directly — no fake timers required, avoiding ESM+fake-timer
// interaction issues.

describe('startDeadlineMonitor / stopDeadlineMonitor lifecycle', () => {
  let capturedCallback: (() => Promise<void>) | null = null
  let consoleLogSpy:   any
  let consoleWarnSpy:  any
  let consoleErrorSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    capturedCallback = null

    consoleLogSpy   = jest.spyOn(console, 'log').mockImplementation(() => {})
    consoleWarnSpy  = jest.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    // Intercept setInterval to capture the callback without scheduling real timers
    jest.spyOn(global, 'setInterval').mockImplementation((fn: any) => {
      capturedCallback = fn
      return 12345 as any
    })
    jest.spyOn(global, 'clearInterval').mockImplementation(() => {})

    resetHorizonChain()
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 10 })
    mockMarkVaultExpiries.mockResolvedValue(0)
  })

  afterEach(() => {
    stopDeadlineMonitor()
    jest.restoreAllMocks()
  })

  it('starts the monitor and logs a startup message', () => {
    startDeadlineMonitor(1000)
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Starting deadline monitor')
    )
  })

  it('passes the given interval duration to setInterval', () => {
    const setIntervalSpy = (global.setInterval as any)
    startDeadlineMonitor(2000)
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000)
  })

  it('uses a default interval of 60000 ms when none is provided', () => {
    const setIntervalSpy = (global.setInterval as any)
    startDeadlineMonitor()
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60000)
  })

  it('logs a warning and does not create a second interval when started twice', () => {
    const setIntervalSpy = (global.setInterval as any)
    startDeadlineMonitor(1000)
    consoleWarnSpy.mockClear()

    startDeadlineMonitor(1000)

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'))
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('calls markVaultExpiries on each tick via the interval callback', async () => {
    startDeadlineMonitor(500)
    await capturedCallback!()
    await capturedCallback!()
    expect(mockMarkVaultExpiries).toHaveBeenCalledTimes(2)
  })

  it('calls checkListenerLag on each tick via the interval callback', async () => {
    startDeadlineMonitor(500)
    await capturedCallback!()
    expect(mockLedgerCall).toHaveBeenCalledTimes(1)
  })

  it('logs vault expiry count when expiries are found', async () => {
    mockMarkVaultExpiries.mockResolvedValue(5)
    startDeadlineMonitor(500)
    await capturedCallback!()
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Processed 5 expired vaults')
    )
  })

  it('does not log vault count when no expiries are found', async () => {
    mockMarkVaultExpiries.mockResolvedValue(0)
    startDeadlineMonitor(500)
    await capturedCallback!()
    const vaultLogs = consoleLogSpy.mock.calls.filter((args: any[]) =>
      String(args[0]).includes('expired vaults')
    )
    expect(vaultLogs).toHaveLength(0)
  })

  it('stops the monitor and logs a stop message', () => {
    startDeadlineMonitor(1000)
    consoleLogSpy.mockClear()
    stopDeadlineMonitor()
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Deadline monitor stopped')
    )
  })

  it('calls clearInterval with the timer ID when stopped', () => {
    const clearIntervalSpy = (global.clearInterval as any)
    startDeadlineMonitor(1000)
    stopDeadlineMonitor()
    expect(clearIntervalSpy).toHaveBeenCalledWith(12345)
  })

  it('is a no-op when stopDeadlineMonitor is called while not running', () => {
    const clearIntervalSpy = (global.clearInterval as any)
    expect(() => stopDeadlineMonitor()).not.toThrow()
    expect(clearIntervalSpy).not.toHaveBeenCalled()
    expect(consoleLogSpy).not.toHaveBeenCalled()
  })

  it('can be restarted after being stopped', async () => {
    startDeadlineMonitor(500)
    stopDeadlineMonitor()
    capturedCallback = null

    startDeadlineMonitor(500)
    expect(capturedCallback).not.toBeNull()
    await capturedCallback!()
    expect(mockMarkVaultExpiries).toHaveBeenCalledTimes(1)
  })

  it('logs an error but keeps the interval alive when the callback throws', async () => {
    mockMarkVaultExpiries.mockRejectedValue(new Error('Vault query failed'))
    startDeadlineMonitor(500)

    await capturedCallback!()

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error during monitor update:'),
      expect.any(Error)
    )
    // Callback reference is still valid — interval continues after error
    expect(capturedCallback).not.toBeNull()
  })

  it('alerts on lag threshold breach within each interval tick', async () => {
    mockGetValidatedConfig.mockReturnValue({ ...BASE_CONFIG, lagThreshold: 10 })
    resetHorizonChain(120, 100) // lag = 20 > 10 → warn
    startDeadlineMonitor(500)

    await capturedCallback!()

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Horizon listener lag detected: 20 ledgers')
    )
  })
})

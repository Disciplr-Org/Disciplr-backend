import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockLedgerCall = jest.fn<any>()
const mockServer = {
  ledgers: jest.fn<any>().mockReturnThis(),
  order: jest.fn<any>().mockReturnThis(),
  limit: jest.fn<any>().mockReturnThis(),
  call: mockLedgerCall,
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

// ─── Subject under test (dynamic import after mocks) ─────────────────────────

const { checkListenerLag } = await import('../services/monitor.js')

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('checkListenerLag', () => {
  let consoleWarnSpy: any
  let consoleErrorSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    mockGetValidatedConfig.mockReturnValue({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      lagThreshold: 10,
      startLedger: 100,
      contractAddresses: ['CTEST123'],
      retryMaxAttempts: 3,
      retryBackoffMs: 100,
      shutdownTimeoutMs: 30000,
    })
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('should log a warning when lag exceeds threshold', async () => {
    mockLedgerCall.mockResolvedValue({ records: [{ sequence: 150 }] })
    mockDbChain.first.mockResolvedValue({ last_processed_ledger: 100 })

    await checkListenerLag()

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Horizon listener lag detected: 50 ledgers')
    )
  })

  it('should not log a warning when lag is within threshold', async () => {
    mockLedgerCall.mockResolvedValue({ records: [{ sequence: 105 }] })
    mockDbChain.first.mockResolvedValue({ last_processed_ledger: 100 })

    await checkListenerLag()

    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('should use startLedger from config if no state exists in DB', async () => {
    mockLedgerCall.mockResolvedValue({ records: [{ sequence: 150 }] })
    mockDbChain.first.mockResolvedValue(null)

    await checkListenerLag()

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Horizon listener lag detected: 50 ledgers')
    )
  })

  it('should handle errors gracefully without crashing', async () => {
    mockServer.ledgers.mockImplementation(() => { throw new Error('Connection failed') })

    await expect(checkListenerLag()).resolves.not.toThrow()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking listener lag:'),
      expect.any(Error)
    )
  })
})

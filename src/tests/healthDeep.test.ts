import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: { $queryRaw: jest.fn<any>().mockResolvedValue([{ '?column?': 1 }]) },
}))

const mockDbChain = {
  where: jest.fn<any>().mockReturnThis(),
  select: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>(),
}
const mockDb = jest.fn<any>(() => mockDbChain)

jest.unstable_mockModule('../db/knex.js', () => ({ db: mockDb }))

jest.unstable_mockModule('../db/knex.js', () => ({ db: mockDb }))

jest.unstable_mockModule('../jobs/system.js', () => ({}))

// ─── Subject under test ───────────────────────────────────────────────────────

const { healthService } = await import('../services/healthService.js')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeStateRow = (minsAgo: number, ledger = 12345) => ({
  last_processed_at: new Date(Date.now() - minsAgo * 60 * 1000).toISOString(),
  last_processed_ledger: ledger,
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('healthService.checkHorizonListener thresholds', () => {
  const origHorizonUrl = process.env.HORIZON_URL
  const origContractAddress = process.env.CONTRACT_ADDRESS

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org'
    process.env.CONTRACT_ADDRESS = 'CTEST123'
    delete process.env.LISTENER_DEGRADED_THRESHOLD_MS
    delete process.env.LISTENER_DOWN_THRESHOLD_MS
  })

  afterEach(() => {
    if (origHorizonUrl === undefined) delete process.env.HORIZON_URL
    else process.env.HORIZON_URL = origHorizonUrl
    if (origContractAddress === undefined) delete process.env.CONTRACT_ADDRESS
    else process.env.CONTRACT_ADDRESS = origContractAddress
    delete process.env.LISTENER_DEGRADED_THRESHOLD_MS
    delete process.env.LISTENER_DOWN_THRESHOLD_MS
  })

  it('returns disabled when HORIZON_URL or CONTRACT_ADDRESS is not set', async () => {
    delete process.env.HORIZON_URL
    const result = await healthService.checkHorizonListener()
    expect(result.status).toBe('disabled')
  })

  it('returns down when no row in listener_state', async () => {
    mockDbChain.first.mockResolvedValue(undefined)
    const result = await healthService.checkHorizonListener()
    expect(result.status).toBe('down')
    expect(result.error).toMatch(/no heartbeat/i)
  })

  it('returns up with ledger and lag fields when heartbeat is fresh', async () => {
    mockDbChain.first.mockResolvedValue(makeStateRow(1, 99000))
    const result = await healthService.checkHorizonListener()
    expect(result.status).toBe('up')
    expect(result.lastProcessedLedger).toBe(99000)
    expect(typeof result.timeSinceLastEventMs).toBe('number')
    expect(result.timeSinceLastEventMs).toBeLessThan(5 * 60 * 1000)
  })

  it('returns stale when heartbeat is between degraded and down thresholds', async () => {
    mockDbChain.first.mockResolvedValue(makeStateRow(10, 88000))
    const result = await healthService.checkHorizonListener()
    expect(result.status).toBe('stale')
    expect(result.lastProcessedLedger).toBe(88000)
    expect(result.timeSinceLastEventMs).toBeGreaterThan(5 * 60 * 1000)
    expect(result.timeSinceLastEventMs).toBeLessThan(30 * 60 * 1000)
  })

  it('returns down when heartbeat exceeds the down threshold (30 minutes)', async () => {
    mockDbChain.first.mockResolvedValue(makeStateRow(35, 77000))
    const result = await healthService.checkHorizonListener()
    expect(result.status).toBe('down')
    expect(result.lastProcessedLedger).toBe(77000)
    expect(result.timeSinceLastEventMs).toBeGreaterThan(30 * 60 * 1000)
    expect(result.error).toMatch(/down/i)
  })

  it('honours custom LISTENER_DEGRADED_THRESHOLD_MS env var', async () => {
    process.env.LISTENER_DEGRADED_THRESHOLD_MS = String(30 * 1000) // 30 seconds
    mockDbChain.first.mockResolvedValue(makeStateRow(1))
    const result = await healthService.checkHorizonListener()
    // 1 minute > 30 seconds → stale
    expect(result.status).toBe('stale')
  })

  it('honours custom LISTENER_DOWN_THRESHOLD_MS env var', async () => {
    process.env.LISTENER_DOWN_THRESHOLD_MS = String(2 * 60 * 1000) // 2 minutes
    mockDbChain.first.mockResolvedValue(makeStateRow(3))
    const result = await healthService.checkHorizonListener()
    // 3 minutes > 2 minutes → down
    expect(result.status).toBe('down')
  })

  it('returns down and error message when db query throws', async () => {
    mockDbChain.first.mockRejectedValue(new Error('DB connection lost'))
    const result = await healthService.checkHorizonListener()
    expect(result.status).toBe('down')
    expect(result.error).toBe('DB connection lost')
  })
})

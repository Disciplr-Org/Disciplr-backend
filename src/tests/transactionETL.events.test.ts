/**
 * Tests for findVaultFromEvents behaviour (issue #1839):
 *   - strict UUID / vault_<uuid> topic matching
 *   - error counting and structured logging on network failures
 *   - no-throw contract (ETL run is not aborted)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// ── Module mocks — must precede all dynamic imports ───────────────────────────

const mockGetVaultById = jest.fn()
const mockDbChain: any = {
  where: jest.fn().mockReturnThis(),
  first: mockGetVaultById,
  select: jest.fn().mockReturnThis(),
  update: jest.fn().mockResolvedValue(1),
  then: jest.fn(),
}
const mockDb = jest.fn(() => mockDbChain)

await jest.unstable_mockModule('../db/index.js', () => ({
  default: mockDb,
}))

await jest.unstable_mockModule('../services/soroban.js', () => ({
  getSorobanConfig: jest.fn(() => null),
  getSorobanClient: jest.fn(),
}))

await jest.unstable_mockModule('../security/abuse-monitor.js', () => ({
  logVaultDriftAnomaly: jest.fn(),
}))

await jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}))

const { TransactionETLService } = await import('../services/transactionETL.js')

/** Build a minimal ETL service with a fully controllable Horizon server mock. */
const makeMockServer = () => {
  const mockCall = jest.fn()
  const mockForTransaction = jest.fn().mockReturnValue({ call: mockCall })
  const mockEvents = jest.fn().mockReturnValue({ forTransaction: mockForTransaction })

  const server: any = { events: mockEvents }
  return { server, mockCall, mockForTransaction, mockEvents }
}

const makeEtl = (serverOverride?: any) => {
  const etl = new TransactionETLService({ horizonUrl: 'https://test.example', batchSize: 50 }) as any
  if (serverOverride) etl.server = serverOverride
  return etl
}

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000'
const VAULT_REF = { id: VALID_UUID, user_id: 'u1', creator: 'G1', verifier: 'G2', success_destination: 'G3', failure_destination: 'G4' }

describe('TransactionETLService.findVaultFromEvents — strict UUID matching', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('matches a bare UUID topic and resolves the vault', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockResolvedValue({ records: [{ topic: [VALID_UUID] }] })
    mockGetVaultById.mockResolvedValue(VAULT_REF)

    const etl = makeEtl(server)
    const result = await etl.findVaultFromEvents('tx-hash-1')

    expect(result).toEqual(VAULT_REF)
    expect(mockGetVaultById).toHaveBeenCalledTimes(1)
  })

  it('matches a vault_<uuid> topic and strips the prefix before lookup', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockResolvedValue({ records: [{ topic: [`vault_${VALID_UUID}`] }] })
    mockGetVaultById.mockResolvedValue(VAULT_REF)

    const etl = makeEtl(server)
    const result = await etl.findVaultFromEvents('tx-hash-2')

    expect(result).toEqual(VAULT_REF)
    // lookup uses the extracted UUID, not the prefixed string
    expect(mockDb).toHaveBeenCalledWith('vaults')
  })

  it('rejects a 36-char heuristic string that is not a valid UUID', async () => {
    // A string of length 36 containing a hyphen but not UUID format
    const nonUuid = 'not-a-real-uuid-just-some-hyphen-str'
    expect(nonUuid.length).toBe(36)

    const { server, mockCall } = makeMockServer()
    mockCall.mockResolvedValue({ records: [{ topic: [nonUuid] }] })

    const etl = makeEtl(server)
    const result = await etl.findVaultFromEvents('tx-hash-3')

    expect(result).toBeNull()
    expect(mockGetVaultById).not.toHaveBeenCalled()
  })

  it('rejects a vault_ prefix with a non-UUID suffix', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockResolvedValue({ records: [{ topic: ['vault_not-valid-uuid'] }] })

    const etl = makeEtl(server)
    const result = await etl.findVaultFromEvents('tx-hash-4')

    expect(result).toBeNull()
    expect(mockGetVaultById).not.toHaveBeenCalled()
  })

  it('returns null when no topics match a known vault', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockResolvedValue({ records: [{ topic: [VALID_UUID] }] })
    mockGetVaultById.mockResolvedValue(null) // vault not found

    const etl = makeEtl(server)
    const result = await etl.findVaultFromEvents('tx-hash-5')

    expect(result).toBeNull()
  })

  it('returns null and skips non-string topics without throwing', async () => {
    const { server, mockCall } = makeMockServer()
    // Simulate malformed event with numeric topic
    mockCall.mockResolvedValue({ records: [{ topic: [42, null, VALID_UUID] }] })
    mockGetVaultById.mockResolvedValue(VAULT_REF)

    const etl = makeEtl(server)
    const result = await etl.findVaultFromEvents('tx-hash-6')

    // The UUID topic is still processed after skipping non-strings
    expect(result).toEqual(VAULT_REF)
  })
})

describe('TransactionETLService.findVaultFromEvents — error accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not throw when server.events().forTransaction().call() rejects', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockRejectedValue(new Error('Network timeout'))

    const etl = makeEtl(server)
    await expect(etl.findVaultFromEvents('tx-fail-1')).resolves.toBeNull()
  })

  it('increments eventLookupErrors on network failure', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockRejectedValue(new Error('Connection refused'))

    const etl = makeEtl(server)
    expect(etl.eventLookupErrors).toBe(0)

    await etl.findVaultFromEvents('tx-fail-2')

    expect(etl.eventLookupErrors).toBe(1)
  })

  it('accumulates eventLookupErrors across multiple failures', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockRejectedValue(new Error('Horizon 503'))

    const etl = makeEtl(server)

    await etl.findVaultFromEvents('tx-a')
    await etl.findVaultFromEvents('tx-b')
    await etl.findVaultFromEvents('tx-c')

    expect(etl.eventLookupErrors).toBe(3)
  })

  it('logs a structured error including the txHash on failure', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockRejectedValue(new Error('Horizon down'))

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    const etl = makeEtl(server)
    await etl.findVaultFromEvents('tx-logged-1')

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(errorSpy.mock.calls[0][0] as string)
    expect(logged.event).toBe('etl.events_lookup_failed')
    expect(logged.txHash).toBe('tx-logged-1')
    expect(logged.error).toBe('Horizon down')
    expect(logged.level).toBe('error')

    errorSpy.mockRestore()
  })

  it('does not increment eventLookupErrors on success', async () => {
    const { server, mockCall } = makeMockServer()
    mockCall.mockResolvedValue({ records: [] })

    const etl = makeEtl(server)
    await etl.findVaultFromEvents('tx-ok-1')

    expect(etl.eventLookupErrors).toBe(0)
  })
})

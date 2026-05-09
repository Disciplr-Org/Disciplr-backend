import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { VaultStatus } from '../types/vault.js'

// Mock the pg pool used by VaultService
const mockQuery = jest.fn<any>()
jest.unstable_mockModule('../db/index.js', () => ({
  pool: { query: mockQuery },
  db: jest.fn<any>(() => ({ where: jest.fn<any>().mockReturnThis(), first: jest.fn<any>() })),
  default: jest.fn<any>(() => ({})),
}))

const { VaultService } = await import('../services/vault.service.js')

const mockVaultData = {
  contractId: 'CTEST',
  creatorAddress: 'GBX...',
  amount: '100000000',
  milestoneHash: 'abc123hash',
  verifierAddress: 'GAX...',
  successDestination: 'GBX...',
  failureDestination: 'GAX...',
  deadline: new Date().toISOString(),
}

describe('VaultService', () => {
  beforeEach(() => jest.clearAllMocks())

  it('createVault successfully inserts into db', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'test-uuid-1', ...mockVaultData, status: VaultStatus.PENDING }],
    })
    const result = await VaultService.createVault(mockVaultData)
    expect(result.id).toBe('test-uuid-1')
    expect(result.status).toBe(VaultStatus.PENDING)
  })

  it('getVaultById returns a vault if found', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'test-uuid-2', status: VaultStatus.ACTIVE }] })
    const result = await VaultService.getVaultById('test-uuid-2')
    expect(result?.id).toBe('test-uuid-2')
  })

  it('getVaultById returns null if not found', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const result = await VaultService.getVaultById('fake-id')
    expect(result).toBeNull()
  })

  it('updateVaultStatus calls pool.query', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await VaultService.updateVaultStatus('vault-1', 'cancelled')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE'),
      expect.arrayContaining(['cancelled', 'vault-1'])
    )
  })

  it('getVaultsByUser returns vaults for address', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'v1' }, { id: 'v2' }] })
    const result = await VaultService.getVaultsByUser('GADDR...')
    expect(result).toHaveLength(2)
  })
})

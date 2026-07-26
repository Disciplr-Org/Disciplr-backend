import assert from 'node:assert/strict.js';
import { test, describe, afterEach } from 'node:test.js';
import { VaultService } from '../services/vault.service.js';
import pool from '../db/index.js';
import { VaultStatus } from '../types/vault.js';

// We will mock the database query to avoid needing a live DB during unit tests
const originalQuery = pool.query;
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

  test('createVault successfully inserts into db', async () => {
    // Mock the DB response
    pool.query = async () => {
      return {
        rows: [{ id: 'test-uuid-1', ...mockVaultData, status: VaultStatus.DRAFT }],
        command: 'INSERT',
        rowCount: 1,
        oid: 0,
        fields: []
      };
    };

    const result = await VaultService.createVault(mockVaultData);
    assert.equal(result.id, 'test-uuid-1');
    assert.equal(result.status, VaultStatus.DRAFT);
  });

  test('getVaultById returns a vault if found', async () => {
    pool.query = async () => ({
      rows: [{ id: 'test-uuid-2', status: VaultStatus.ACTIVE }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: []
    }) as any;

    const result = await VaultService.getVaultById('test-uuid-2');
    assert.notEqual(result, null);
    assert.equal(result?.id, 'test-uuid-2');
  });

  test('getVaultById returns null if not found', async () => {
    pool.query = async () => ({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: []
    }) as any;

    const result = await VaultService.getVaultById('fake-id');
    assert.equal(result, null);
  });
});
  it('createVault successfully inserts into db', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'test-uuid-1', ...mockVaultData, status: VaultStatus.DRAFT }],
    })
    const result = await VaultService.createVault(mockVaultData)
    expect(result.id).toBe('test-uuid-1')
    expect(result.status).toBe(VaultStatus.DRAFT)
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

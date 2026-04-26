import { jest } from '@jest/globals';
import assert from 'node:assert/strict';
import { VaultService } from '../services/vault.service.js';
import pool from '../db/index.js';
import { VaultStatus } from '../types/vault.js';

// We will mock the database query to avoid needing a live DB during unit tests
const originalQuery = pool.query;

describe('VaultService', () => {
  
  afterEach(() => {
    // Restore the original query function after each test
    pool.query = originalQuery;
  });

  const mockVaultData = {
    creatorAddress: 'GBX...',
    amount: '100000000',
    milestoneHash: 'abc123hash',
    verifierAddress: 'GAX...',
    successDestination: 'GBX...',
    failureDestination: 'GAX...',
    deadline: new Date().toISOString()
  };

  test('createVault successfully inserts into db', async () => {
    // Mock the DB response
    pool.query = async () => ({
      rows: [{ id: 'test-uuid-1', ...mockVaultData, status: VaultStatus.PENDING }],
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      fields: []
    }) as any;

    const result = await VaultService.createVault(mockVaultData);
    assert.equal(result.id, 'test-uuid-1');
    assert.equal(result.status, VaultStatus.PENDING);
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
    assert.notStrictEqual(result, null);
    if (result) {
      assert.strictEqual(result.id, 'test-uuid-2');
    }
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

  test('getVaultById returns vault from legacy fallback when DB fails', async () => {
    // Mock DB to fail
    pool.query = async () => {
      throw new Error('DB connection failed');
    };

    const result = await VaultService.getVaultById('test-id');
    assert.equal(result, null);
  });

  test('getVaultById returns vault from legacy fallback when found', async () => {
    // Mock DB to fail
    pool.query = async () => {
      throw new Error('DB connection failed');
    };

    // Mock legacy vaults array to have test data
    const { getVaultStore, setVaultStore } = await import('../services/vaultStore.js');
    setVaultStore([{ id: 'test-id', creator: 'test-creator' }]);

    const result = await VaultService.getVaultById('test-id');
    assert.equal(result.id, 'test-id');
    assert.equal(result.creator, 'test-creator');
  });
});
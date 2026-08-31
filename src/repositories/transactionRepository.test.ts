import { Knex } from 'knex';
import { TransactionRepository, TransactionFilters } from './transactionRepository.js';
import { Transaction } from '../types/transactions.js';
import { jest } from '@jest/globals';
import { encodeCursor } from '../utils/pagination.js';

describe('TransactionRepository', () => {
  let mockDb: any;
  let repo: TransactionRepository;

  beforeEach(() => {
    // Mock the query builder for typical chaining
    const mockQueryBuilder: any = {
      where: jest.fn<any>().mockReturnThis(),
      orWhere: jest.fn<any>().mockReturnThis(),
      andWhere: jest.fn<any>().mockReturnThis(),
      orderBy: jest.fn<any>().mockReturnThis(),
      limit: jest.fn<any>().mockReturnThis(),
      offset: jest.fn<any>().mockReturnThis(),
      insert: jest.fn<any>().mockReturnThis(),
      onConflict: jest.fn<any>().mockReturnThis(),
      ignore: jest.fn<any>().mockReturnThis(),
      returning: jest.fn<any>().mockResolvedValue([{ id: 'tx-1', tx_hash: 'hash-1' }]),
      first: jest.fn<any>().mockResolvedValue({ id: 'tx-1', tx_hash: 'hash-1' }),
      count: jest.fn<any>().mockReturnThis(),
      clone: jest.fn<any>().mockReturnThis(),
    };

    const dbCallable: any = jest.fn<any>().mockReturnValue(mockQueryBuilder);
    dbCallable.fn = { now: jest.fn().mockReturnValue('now()') };

    mockDb = Object.assign(dbCallable, {
      raw: jest.fn<any>(),
    });

    repo = new TransactionRepository(mockDb as unknown as Knex);
  });

  describe('create', () => {
    it('should successfully insert a new transaction', async () => {
      const tx = { tx_hash: 'hash-1', user_id: 'user-1', vault_id: 'vault-1', type: 'creation' };
      const result = await repo.create(tx);
      expect(result).toEqual({ id: 'tx-1', tx_hash: 'hash-1' });
      
      const insertCall = mockDb().insert.mock.calls[0][0];
      expect(insertCall).toMatchObject(tx);
      expect(mockDb().onConflict).toHaveBeenCalledWith('tx_hash');
      expect(mockDb().ignore).toHaveBeenCalled();
    });

    it('should return existing transaction if conflict occurs (duplicate event)', async () => {
      // simulate .returning() returning empty array due to .ignore()
      mockDb().returning.mockResolvedValueOnce([]);
      
      const tx = { tx_hash: 'hash-1', user_id: 'user-1', vault_id: 'vault-1', type: 'creation' };
      const result = await repo.create(tx);
      
      expect(result).toEqual({ id: 'tx-1', tx_hash: 'hash-1' });
      // findByHash should be called
      expect(mockDb).toHaveBeenCalledWith('transactions');
      // where({ tx_hash: 'hash-1' }) should have been called
      expect(mockDb().where).toHaveBeenCalledWith({ tx_hash: 'hash-1' });
    });

    it('should throw error if transaction not found after ignore', async () => {
      mockDb().returning.mockResolvedValueOnce([]);
      mockDb().first.mockResolvedValueOnce(undefined);
      
      const tx = { tx_hash: 'hash-unknown', user_id: 'user-1', vault_id: 'vault-1', type: 'creation' };
      await expect(repo.create(tx)).rejects.toThrow(/Failed to create or retrieve/);
    });
  });

  describe('findByHash', () => {
    it('should find transaction by hash successfully', async () => {
      const result = await repo.findByHash('hash-1');
      expect(result).toEqual({ id: 'tx-1', tx_hash: 'hash-1' });
      expect(mockDb().where).toHaveBeenCalledWith({ tx_hash: 'hash-1' });
    });

    it('should return undefined when transaction not found (empty state)', async () => {
      mockDb().first.mockResolvedValueOnce(undefined);
      const result = await repo.findByHash('hash-unknown');
      expect(result).toBeUndefined();
    });
  });

  describe('listWithCursor', () => {
    it('should list transactions without filters', async () => {
      mockDb().limit.mockResolvedValueOnce([
        { id: 'tx-2', stellar_timestamp: new Date('2023-01-02T00:00:00Z') },
        { id: 'tx-1', stellar_timestamp: new Date('2023-01-01T00:00:00Z') }
      ]);
      
      const result = await repo.listWithCursor('user-1', 10);
      expect(result.data).toHaveLength(2);
      expect(result.pagination.has_more).toBe(false);
      expect(mockDb().where).toHaveBeenCalledWith({ user_id: 'user-1' });
    });

    it('should handle pagination when there are more items', async () => {
      mockDb().limit.mockResolvedValueOnce([
        { id: 'tx-2', stellar_timestamp: new Date('2023-01-02T00:00:00Z') },
        { id: 'tx-1', stellar_timestamp: new Date('2023-01-01T00:00:00Z') }
      ]);
      
      const result = await repo.listWithCursor('user-1', 1); // limit is 1
      expect(result.data).toHaveLength(1);
      expect(result.pagination.has_more).toBe(true);
      expect(result.pagination.next_cursor).toBeDefined();
    });
    
    it('should apply all filters correctly', async () => {
      mockDb().limit.mockResolvedValueOnce([]);
      const filters: TransactionFilters = {
        vaultId: 'vault-1',
        type: 'creation',
        dateFrom: new Date('2023-01-01'),
        dateTo: new Date('2023-12-31'),
        amountMin: '10',
        amountMax: '100',
      };
      
      await repo.listWithCursor('user-1', 10, undefined, filters);
      expect(mockDb().where).toHaveBeenCalledWith({ vault_id: 'vault-1' });
      expect(mockDb().where).toHaveBeenCalledWith({ type: 'creation' });
      expect(mockDb().where).toHaveBeenCalledWith('stellar_timestamp', '>=', filters.dateFrom);
      expect(mockDb().where).toHaveBeenCalledWith('stellar_timestamp', '<=', filters.dateTo);
      expect(mockDb().where).toHaveBeenCalledWith('amount', '>=', filters.amountMin);
      expect(mockDb().where).toHaveBeenCalledWith('amount', '<=', filters.amountMax);
    });

    it('should apply cursor query when provided', async () => {
      mockDb().limit.mockResolvedValueOnce([]);
      const cursor = encodeCursor(new Date('2023-01-02T00:00:00Z'), 'tx-2');
      await repo.listWithCursor('user-1', 10, cursor);
      
      // Since we mocked function builder loosely, just verifying where was called with a function
      const whereCalls = mockDb().where.mock.calls;
      const functionCall = whereCalls.find((call: any[]) => typeof call[0] === 'function');
      expect(functionCall).toBeDefined();
    });
  });

  describe('list', () => {
    it('should return data and total count', async () => {
      mockDb().first.mockResolvedValueOnce({ count: '5' });
      mockDb().offset.mockResolvedValueOnce([
        { id: 'tx-1' },
        { id: 'tx-2' }
      ]);
      
      const result = await repo.list('user-1', 10, 0);
      expect(result.total).toBe(5);
      expect(result.data).toHaveLength(2);
    });
  });
});

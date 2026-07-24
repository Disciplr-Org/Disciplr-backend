import { describe, it, beforeEach, beforeAll, afterAll, expect } from '@jest/globals';
import knex, { Knex } from 'knex';
import crypto from 'node:crypto';
import { TransactionRepository, TransactionFilters } from '../repositories/transactionRepository.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import type { Transaction } from '../types/transactions.js';

const TEST_DB_URL = process.env.DATABASE_URL;

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-a000-${hex}`;
}

const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb('TransactionRepository', () => {
  let db: Knex | null = null;
  let repo: TransactionRepository;
  const userId = uuid(999);

  beforeAll(async () => {
    if (!TEST_DB_URL) return;
    db = knex({
      client: 'pg',
      connection: TEST_DB_URL,
    });
    await db.raw('SELECT 1');
    repo = new TransactionRepository(db);
  });

  beforeEach(async () => {
    if (!db) return;
    await db('transactions').delete();
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  function createTestTransaction(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: crypto.randomUUID(),
      user_id: userId,
      vault_id: uuid(100),
      tx_hash: crypto.randomBytes(32).toString('hex'),
      type: 'creation',
      amount: '100.0000000',
      asset_code: null,
      from_account: 'GTESTFROMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      to_account: 'GTESTTOXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      memo: null,
      created_at: new Date(),
      stellar_ledger: 123456,
      stellar_timestamp: new Date(),
      explorer_url: 'https://example.com',
      ...overrides,
    } as Transaction;
  }

  describe('encodeCursor / decodeCursor', () => {
    it('encodes and decodes a cursor correctly (round-trip)', () => {
      const timestamp = new Date('2026-06-28T10:00:00Z');
      const id = uuid(123);
      const cursor = encodeCursor(timestamp, id);
      const decoded = decodeCursor(cursor);

      expect(decoded.timestamp.toISOString()).toEqual(timestamp.toISOString());
      expect(decoded.id).toEqual(id);
    });

    it('throws when decoding a tampered cursor', () => {
      expect(() => decodeCursor('invalid-base64url')).toThrow('Invalid cursor');
    });

    it('throws when decoding a cursor with invalid format', () => {
      const invalidCursor = Buffer.from('no-pipe-separator').toString('base64url');
      expect(() => decodeCursor(invalidCursor)).toThrow('Invalid cursor');
    });
  });

  describe('listWithCursor', () => {
    it('returns transactions ordered by stellar_timestamp descending and id descending', async () => {
      if (!db) return;

      const tx1 = createTestTransaction({
        id: uuid(1),
        stellar_timestamp: new Date('2026-06-28T10:00:00Z')
      });
      const tx2 = createTestTransaction({
        id: uuid(2),
        stellar_timestamp: new Date('2026-06-28T10:01:00Z')
      });
      const tx3 = createTestTransaction({
        id: uuid(3),
        stellar_timestamp: new Date('2026-06-28T10:01:00Z') // same timestamp
      });

      await db('transactions').insert([tx1, tx2, tx3]);

      const result = await repo.listWithCursor(userId, 10);
      expect(result.data.map(t => t.id)).toEqual([tx3.id, tx2.id, tx1.id]);
    });

    it('does not skip or duplicate rows when new transactions are inserted between pages', async () => {
      if (!db) return;

      const tx1 = createTestTransaction({ id: uuid(1), stellar_timestamp: new Date('2026-06-28T10:00:00Z') });
      const tx2 = createTestTransaction({ id: uuid(2), stellar_timestamp: new Date('2026-06-28T10:01:00Z') });
      const tx3 = createTestTransaction({ id: uuid(3), stellar_timestamp: new Date('2026-06-28T10:02:00Z') });
      const tx4 = createTestTransaction({ id: uuid(4), stellar_timestamp: new Date('2026-06-28T10:03:00Z') });

      await db('transactions').insert([tx1, tx2, tx3, tx4]);

      const firstPage = await repo.listWithCursor(userId, 2);
      expect(firstPage.data.map(t => t.id)).toEqual([tx4.id, tx3.id]);
      expect(firstPage.pagination.has_more).toBe(true);

      // Insert a new transaction that would have been at the start
      const txNew = createTestTransaction({ id: uuid(5), stellar_timestamp: new Date('2026-06-28T10:04:00Z') });
      await db('transactions').insert(txNew);

      const secondPage = await repo.listWithCursor(userId, 2, firstPage.pagination.next_cursor);
      expect(secondPage.data.map(t => t.id)).toEqual([tx2.id, tx1.id]);
    });

    it('applies combined filters correctly', async () => {
      if (!db) return;

      const vaultIdA = uuid(200);
      const vaultIdB = uuid(201);
      const tx1 = createTestTransaction({
        id: uuid(1),
        vault_id: vaultIdA,
        type: 'creation',
        stellar_timestamp: new Date('2026-06-28T10:00:00Z'),
        amount: '50.0000000',
      });
      const tx2 = createTestTransaction({
        id: uuid(2),
        vault_id: vaultIdB,
        type: 'release',
        stellar_timestamp: new Date('2026-06-28T10:01:00Z'),
        amount: '150.0000000',
      });
      const tx3 = createTestTransaction({
        id: uuid(3),
        vault_id: vaultIdA,
        type: 'release',
        stellar_timestamp: new Date('2026-06-29T10:00:00Z'),
        amount: '200.0000000',
      });

      await db('transactions').insert([tx1, tx2, tx3]);

      const filters: TransactionFilters = {
        vaultId: vaultIdA,
        type: 'release',
        dateFrom: new Date('2026-06-28T00:00:00Z'),
        dateTo: new Date('2026-06-30T00:00:00Z'),
        amountMin: '100.0000000',
      };
      const result = await repo.listWithCursor(userId, 10, undefined, filters);
      expect(result.data.map(t => t.id)).toEqual([tx3.id]);
    });
  });
});
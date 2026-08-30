import { Knex } from 'knex';
import { Transaction } from '../types/transactions.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';

export class TransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionValidationError';
  }
}

export class TransactionAuthorizationError extends Error {
  constructor(message: string = 'Unauthorized: user identity required') {
    super(message);
    this.name = 'TransactionAuthorizationError';
  }
}

export const ALLOWED_TRANSACTION_TYPES = [
  'creation',
  'validation',
  'release',
  'redirect',
  'cancel',
  'deposit',
  'withdrawal',
  'reward',
  'slash',
  'fee',
  'transfer',
] as const;

export type AllowedTransactionType = (typeof ALLOWED_TRANSACTION_TYPES)[number];

export interface TransactionFilters {
  vaultId?: string;
  type?: string;
  dateFrom?: Date;
  dateTo?: Date;
  amountMin?: string;
  amountMax?: string;
}

export interface TransactionListResponse {
  data: Transaction[];
  pagination: {
    limit: number;
    next_cursor?: string;
    has_more: boolean;
  };
}

/**
 * Validates transaction creation invariants.
 */
export function validateTransactionInput(transaction: Partial<Transaction>): void {
  if (!transaction || typeof transaction !== 'object') {
    throw new TransactionValidationError('Transaction payload must be an object');
  }

  if (!transaction.user_id || typeof transaction.user_id !== 'string' || transaction.user_id.trim().length === 0) {
    throw new TransactionValidationError('user_id is required and must be a non-empty string');
  }

  if (!transaction.vault_id || typeof transaction.vault_id !== 'string' || transaction.vault_id.trim().length === 0) {
    throw new TransactionValidationError('vault_id is required and must be a non-empty string');
  }

  if (!transaction.tx_hash || typeof transaction.tx_hash !== 'string' || transaction.tx_hash.trim().length === 0) {
    throw new TransactionValidationError('tx_hash is required and must be a non-empty string');
  }

  if (transaction.tx_hash.length > 256) {
    throw new TransactionValidationError('tx_hash exceeds maximum length of 256 characters');
  }

  if (
    !transaction.type ||
    typeof transaction.type !== 'string' ||
    !ALLOWED_TRANSACTION_TYPES.includes(transaction.type as AllowedTransactionType)
  ) {
    throw new TransactionValidationError(
      `Invalid transaction type: "${transaction.type}". Allowed types: ${ALLOWED_TRANSACTION_TYPES.join(', ')}`
    );
  }

  if (transaction.amount !== undefined && transaction.amount !== null) {
    const num = Number(transaction.amount);
    if (typeof transaction.amount !== 'string' && typeof transaction.amount !== 'number') {
      throw new TransactionValidationError('amount must be a valid numeric string or number');
    }
    if (!Number.isFinite(num) || Number.isNaN(num) || num < 0) {
      throw new TransactionValidationError('amount must be a non-negative finite numeric value');
    }
  }

  if (transaction.stellar_ledger !== undefined && transaction.stellar_ledger !== null) {
    if (
      typeof transaction.stellar_ledger !== 'number' ||
      !Number.isSafeInteger(transaction.stellar_ledger) ||
      transaction.stellar_ledger < 0
    ) {
      throw new TransactionValidationError('stellar_ledger must be a non-negative safe integer');
    }
  }

  if (transaction.stellar_timestamp !== undefined && transaction.stellar_timestamp !== null) {
    const d = new Date(transaction.stellar_timestamp);
    if (isNaN(d.getTime())) {
      throw new TransactionValidationError('stellar_timestamp must be a valid date');
    }
  }
}

/**
 * Validates filter parameters for transaction listing.
 */
export function validateTransactionFilters(filters: TransactionFilters): void {
  if (filters.type && !ALLOWED_TRANSACTION_TYPES.includes(filters.type as AllowedTransactionType)) {
    throw new TransactionValidationError(
      `Invalid filter type: "${filters.type}". Allowed types: ${ALLOWED_TRANSACTION_TYPES.join(', ')}`
    );
  }

  if (filters.amountMin !== undefined) {
    const min = Number(filters.amountMin);
    if (!Number.isFinite(min) || Number.isNaN(min) || min < 0) {
      throw new TransactionValidationError('amountMin must be a non-negative finite number');
    }
  }

  if (filters.amountMax !== undefined) {
    const max = Number(filters.amountMax);
    if (!Number.isFinite(max) || Number.isNaN(max) || max < 0) {
      throw new TransactionValidationError('amountMax must be a non-negative finite number');
    }
  }

  if (filters.amountMin !== undefined && filters.amountMax !== undefined) {
    const min = Number(filters.amountMin);
    const max = Number(filters.amountMax);
    if (min > max) {
      throw new TransactionValidationError('amountMin cannot exceed amountMax');
    }
  }

  if (filters.dateFrom && isNaN(filters.dateFrom.getTime())) {
    throw new TransactionValidationError('dateFrom must be a valid date');
  }

  if (filters.dateTo && isNaN(filters.dateTo.getTime())) {
    throw new TransactionValidationError('dateTo must be a valid date');
  }

  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new TransactionValidationError('dateFrom cannot be after dateTo');
  }
}

export function clampLimit(limit?: number): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || Number.isNaN(limit)) {
    return 20;
  }
  return Math.max(1, Math.min(Math.floor(limit), 100));
}

export function clampOffset(offset?: number): number {
  if (offset === undefined || offset === null || !Number.isFinite(offset) || Number.isNaN(offset)) {
    return 0;
  }
  return Math.max(0, Math.floor(offset));
}

export class TransactionRepository {
  constructor(private db: Knex) {}

  /**
   * Create a new transaction record with boundary validation.
   */
  async create(transaction: Partial<Transaction>): Promise<Transaction> {
    validateTransactionInput(transaction);

    const [created] = await this.db('transactions')
      .insert({
        ...transaction,
        created_at: this.db.fn.now(),
      })
      .returning('*');
    return created;
  }

  /**
   * List transactions with cursor-based pagination and strict authorization.
   */
  async listWithCursor(
    userId: string,
    limit: number,
    cursor?: string,
    filters: TransactionFilters = {}
  ): Promise<TransactionListResponse> {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new TransactionAuthorizationError('userId is required for transaction retrieval');
    }

    validateTransactionFilters(filters);
    const safeLim = clampLimit(limit);

    let query = this.db('transactions')
      .where({ user_id: userId.trim() })
      .orderBy('stellar_timestamp', 'desc')
      .orderBy('id', 'desc')
      .limit(safeLim + 1);

    if (filters.vaultId) {
      query = query.where({ vault_id: filters.vaultId.trim() });
    }
    if (filters.type) {
      query = query.where({ type: filters.type.trim() });
    }
    if (filters.dateFrom) {
      query = query.where('stellar_timestamp', '>=', filters.dateFrom);
    }
    if (filters.dateTo) {
      query = query.where('stellar_timestamp', '<=', filters.dateTo);
    }
    if (filters.amountMin) {
      query = query.where('amount', '>=', filters.amountMin);
    }
    if (filters.amountMax) {
      query = query.where('amount', '<=', filters.amountMax);
    }

    if (cursor) {
      try {
        const { timestamp, id } = decodeCursor(cursor);
        if (!timestamp || !id || isNaN(new Date(timestamp).getTime())) {
          throw new Error('Invalid cursor components');
        }
        query = query.where(function () {
          this.where('stellar_timestamp', '<', timestamp)
            .orWhere(function () {
              this.where('stellar_timestamp', '=', timestamp)
                .andWhere('id', '<', id);
            });
        });
      } catch (err) {
        throw new TransactionValidationError('Invalid pagination cursor');
      }
    }

    const transactions = await query;
    const hasMore = transactions.length > safeLim;
    const data = hasMore ? transactions.slice(0, safeLim) : transactions;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      nextCursor = encodeCursor(new Date(lastItem.stellar_timestamp), lastItem.id);
    }

    return {
      data,
      pagination: {
        limit: safeLim,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    };
  }

  /**
   * List transactions with page-based pagination.
   */
  async list(
    userId: string,
    limit: number,
    offset: number,
    filters: TransactionFilters = {}
  ): Promise<{ data: Transaction[]; total: number }> {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new TransactionAuthorizationError('userId is required for transaction retrieval');
    }

    validateTransactionFilters(filters);
    const safeLim = clampLimit(limit);
    const safeOff = clampOffset(offset);

    let query = this.db('transactions').where({ user_id: userId.trim() });

    if (filters.vaultId) {
      query = query.where({ vault_id: filters.vaultId.trim() });
    }
    if (filters.type) {
      query = query.where({ type: filters.type.trim() });
    }
    if (filters.dateFrom) {
      query = query.where('stellar_timestamp', '>=', filters.dateFrom);
    }
    if (filters.dateTo) {
      query = query.where('stellar_timestamp', '<=', filters.dateTo);
    }
    if (filters.amountMin) {
      query = query.where('amount', '>=', filters.amountMin);
    }
    if (filters.amountMax) {
      query = query.where('amount', '<=', filters.amountMax);
    }

    const totalRes = await query.clone().count('* as count').first();
    const total = parseInt(totalRes?.count as string || '0', 10);

    const data = await query
      .orderBy('stellar_timestamp', 'desc')
      .orderBy('id', 'desc')
      .limit(safeLim)
      .offset(safeOff);

    return { data, total };
  }

  /**
   * Find a transaction by its hash, optionally scoped by user authorization.
   */
  async findByHash(txHash: string, userId?: string): Promise<Transaction | undefined> {
    if (!txHash || typeof txHash !== 'string' || txHash.trim().length === 0) {
      throw new TransactionValidationError('txHash is required and must be a non-empty string');
    }

    let query = this.db('transactions').where({ tx_hash: txHash.trim() });
    if (userId && typeof userId === 'string' && userId.trim().length > 0) {
      query = query.where({ user_id: userId.trim() });
    }
    return query.first();
  }

  /**
   * Find a transaction by its ID, optionally scoped by user authorization.
   */
  async findById(id: string, userId?: string): Promise<Transaction | undefined> {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new TransactionValidationError('id is required and must be a non-empty string');
    }

    let query = this.db('transactions').where({ id: id.trim() });
    if (userId && typeof userId === 'string' && userId.trim().length > 0) {
      query = query.where({ user_id: userId.trim() });
    }
    return query.first();
  }

  /**
   * List transactions for a vault, verifying ownership or membership.
   */
  async listByVault(
    vaultId: string,
    userId: string,
    limit: number,
    cursor?: string,
    filters: TransactionFilters = {}
  ): Promise<TransactionListResponse> {
    if (!vaultId || typeof vaultId !== 'string' || vaultId.trim().length === 0) {
      throw new TransactionValidationError('vaultId is required and must be a non-empty string');
    }
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new TransactionAuthorizationError('userId is required to access vault transactions');
    }

    // Verify access to the vault
    const vault = await this.db('vaults')
      .leftJoin('memberships', 'vaults.organization_id', 'memberships.organization_id')
      .where('vaults.id', vaultId.trim())
      .where(function () {
        this.where('vaults.creator', userId.trim()).orWhere('memberships.user_id', userId.trim());
      })
      .select('vaults.id')
      .first();

    if (!vault) {
      throw new TransactionAuthorizationError('Vault not found or user lacks authorization');
    }

    const safeLim = clampLimit(limit);
    validateTransactionFilters(filters);

    let query = this.db('transactions')
      .where('vault_id', vaultId.trim())
      .orderBy('stellar_timestamp', 'desc')
      .orderBy('id', 'desc')
      .limit(safeLim + 1);

    if (filters.type) {
      query = query.where('type', filters.type.trim());
    }
    if (filters.dateFrom) {
      query = query.where('stellar_timestamp', '>=', filters.dateFrom);
    }
    if (filters.dateTo) {
      query = query.where('stellar_timestamp', '<=', filters.dateTo);
    }
    if (filters.amountMin) {
      query = query.where('amount', '>=', filters.amountMin);
    }
    if (filters.amountMax) {
      query = query.where('amount', '<=', filters.amountMax);
    }

    if (cursor) {
      try {
        const { timestamp, id } = decodeCursor(cursor);
        if (!timestamp || !id || isNaN(new Date(timestamp).getTime())) {
          throw new Error('Invalid cursor components');
        }
        query = query.where(function () {
          this.where('stellar_timestamp', '<', timestamp)
            .orWhere(function () {
              this.where('stellar_timestamp', '=', timestamp)
                .andWhere('id', '<', id);
            });
        });
      } catch (err) {
        throw new TransactionValidationError('Invalid pagination cursor');
      }
    }

    const transactions = await query;
    const hasMore = transactions.length > safeLim;
    const data = hasMore ? transactions.slice(0, safeLim) : transactions;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      nextCursor = encodeCursor(new Date(lastItem.stellar_timestamp), lastItem.id);
    }

    return {
      data,
      pagination: {
        limit: safeLim,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    };
  }
}


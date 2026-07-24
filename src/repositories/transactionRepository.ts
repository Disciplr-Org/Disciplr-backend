import { Knex } from 'knex';
import { Transaction } from '../types/transactions.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';

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

export class TransactionRepository {
  constructor(private db: Knex) {}

  /**
   * Create a new transaction record
   */
  async create(transaction: Partial<Transaction>): Promise<Transaction> {
    const [created] = await this.db('transactions')
      .insert({
        ...transaction,
        created_at: this.db.fn.now(),
      })
      .returning('*');
    return created;
  }

  /**
   * List transactions with cursor-based pagination
   */
  async listWithCursor(
    userId: string,
    limit: number,
    cursor?: string,
    filters: TransactionFilters = {}
  ): Promise<TransactionListResponse> {
    let query = this.db('transactions')
      .where({ user_id: userId })
      .orderBy('stellar_timestamp', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1); // Fetch one extra to check if there's more

    if (filters.vaultId) {
      query = query.where({ vault_id: filters.vaultId });
    }
    if (filters.type) {
      query = query.where({ type: filters.type });
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
      const { timestamp, id } = decodeCursor(cursor);
      query = query.where(function () {
        this.where('stellar_timestamp', '<', timestamp)
          .orWhere(function () {
            this.where('stellar_timestamp', '=', timestamp)
              .andWhere('id', '<', id);
          });
      });
    }

    const transactions = await query;
    const hasMore = transactions.length > limit;
    const data = hasMore ? transactions.slice(0, limit) : transactions;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      nextCursor = encodeCursor(new Date(lastItem.stellar_timestamp), lastItem.id);
    }

    return {
      data,
      pagination: {
        limit,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    };
  }

  /**
   * List transactions with page-based pagination
   */
  async list(
    userId: string,
    limit: number,
    offset: number,
    filters: TransactionFilters = {}
  ): Promise<{ data: Transaction[]; total: number }> {
    let query = this.db('transactions').where({ user_id: userId });

    if (filters.vaultId) {
      query = query.where({ vault_id: filters.vaultId });
    }
    if (filters.type) {
      query = query.where({ type: filters.type });
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
      .limit(limit)
      .offset(offset);

    return { data, total };
  }

  /**
   * Find a transaction by its hash
   */
  async findByHash(txHash: string): Promise<Transaction | undefined> {
    return this.db('transactions').where({ tx_hash: txHash }).first();
  }
}

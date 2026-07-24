import { Knex } from 'knex'
import type { ETLBatch, ETLBatchStatus } from '../types/transactions.js'

/**
 * Repository for ETL batch lifecycle management.
 *
 * Idempotency guarantee:
 *   - `create` inserts a new 'pending' row; the UNIQUE primary key (batch_id)
 *     prevents double-insertion at the DB level.
 *   - `markRunning` / `markCompleted` / `markFailed` are safe to call more
 *     than once – they are conditional updates that only advance the state
 *     forward (pending → running → completed|failed).
 */
export class ETLBatchRepository {
  constructor(private readonly db: Knex) {}

  /**
   * Create a new batch record in 'pending' state.
   * Throws if the batch_id already exists (duplicate run guard).
   */
  async create(batchId: string): Promise<ETLBatch> {
    const [row] = await this.db('etl_batches')
      .insert({
        batch_id: batchId,
        status: 'pending' as ETLBatchStatus,
        operations_fetched: 0,
        transactions_inserted: 0,
        transactions_skipped: 0,
        created_at: new Date(),
      })
      .returning('*')
    return row as ETLBatch
  }

  /**
   * Transition batch to 'running'.  No-op if already past 'pending'.
   */
  async markRunning(batchId: string): Promise<void> {
    await this.db('etl_batches')
      .where({ batch_id: batchId, status: 'pending' })
      .update({ status: 'running', started_at: new Date() })
  }

  /**
   * Transition batch to 'completed' and persist final counts + duration.
   * No-op if the batch is already in a terminal state.
   */
  async markCompleted(
    batchId: string,
    counts: { operationsFetched: number; transactionsInserted: number; transactionsSkipped: number },
    durationMs: number,
  ): Promise<void> {
    const finishedAt = new Date()
    await this.db('etl_batches')
      .where({ batch_id: batchId })
      .whereNotIn('status', ['completed', 'failed'])
      .update({
        status: 'completed',
        operations_fetched: counts.operationsFetched,
        transactions_inserted: counts.transactionsInserted,
        transactions_skipped: counts.transactionsSkipped,
        finished_at: finishedAt,
        duration_ms: durationMs,
      })
  }

  /**
   * Transition batch to 'failed' and record the error.
   * No-op if already in a terminal state.
   */
  async markFailed(batchId: string, errorMessage: string, durationMs: number): Promise<void> {
    const finishedAt = new Date()
    await this.db('etl_batches')
      .where({ batch_id: batchId })
      .whereNotIn('status', ['completed', 'failed'])
      .update({
        status: 'failed',
        error_message: errorMessage,
        finished_at: finishedAt,
        duration_ms: durationMs,
      })
  }

  /**
   * Check whether a batch has already completed successfully.
   * Used to short-circuit retries of the same logical batch.
   */
  async isCompleted(batchId: string): Promise<boolean> {
    const row = await this.db('etl_batches')
      .where({ batch_id: batchId, status: 'completed' })
      .first()
    return !!row
  }

  /**
   * Fetch a batch record by ID.
   */
  async findById(batchId: string): Promise<ETLBatch | null> {
    const row = await this.db('etl_batches').where({ batch_id: batchId }).first()
    return (row as ETLBatch) ?? null
  }

  /**
   * Return the most recent N batches (for health / monitoring endpoints).
   */
  async listRecent(limit = 20): Promise<ETLBatch[]> {
    return this.db('etl_batches').orderBy('created_at', 'desc').limit(limit) as Promise<ETLBatch[]>
  }
}

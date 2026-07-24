import { Knex } from 'knex'
import { HorizonCheckpoint } from '../types/horizonSync.js'

/**
 * CheckpointStore
 *
 * Persists per-contract-address processing cursors to the horizon_checkpoints
 * table.  Every successful event commit is followed by an upsert here so the
 * listener can resume from the correct ledger after a restart.
 *
 * At-least-once semantics: if the process dies after committing the event but
 * before writing the checkpoint, the event will be re-delivered on next start.
 * The processed_events idempotency table absorbs that re-delivery without
 * duplicate side-effects.
 *
 * The optional `trx` parameter on `upsertCheckpoint` allows callers to include
 * the checkpoint write inside the same database transaction as the event
 * business logic for a fully atomic advance, which upgrades the guarantee to
 * effectively-once for the business tables.
 */
export class CheckpointStore {
  constructor(private readonly db: Knex) {}

  /**
   * Return the stored checkpoint for one contract, or null if none exists.
   */
  async getCheckpoint(contractAddress: string): Promise<HorizonCheckpoint | null> {
    const row = await this.db('horizon_checkpoints')
      .where({ contract_address: contractAddress })
      .first()

    return row ? this.mapRow(row) : null
  }

  /**
   * Return all stored checkpoints ordered by contract_address.
   */
  async getAllCheckpoints(): Promise<HorizonCheckpoint[]> {
    const rows = await this.db('horizon_checkpoints').orderBy('contract_address', 'asc')
    return rows.map((r: Record<string, unknown>) => this.mapRow(r))
  }

  /**
   * Create or advance the checkpoint for a contract.
   *
   * Only advances the ledger — this method never moves a checkpoint backwards.
   * Use `resetCheckpoint` for intentional operator rollbacks.
   *
   * @param contractAddress  Soroban contract address.
   * @param lastLedger       Ledger sequence that was just successfully processed.
   * @param lastPagingToken  Horizon SSE paging token (null when not available).
   * @param trx              Optional transaction to join for atomic commit.
   */
  async upsertCheckpoint(
    contractAddress: string,
    lastLedger: number,
    lastPagingToken: string | null = null,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const now = new Date()
    const client = trx ?? this.db

    await (client as Knex)('horizon_checkpoints')
      .insert({
        contract_address: contractAddress,
        last_ledger: lastLedger,
        last_paging_token: lastPagingToken,
        updated_at: now,
        created_at: now,
      })
      .onConflict('contract_address')
      .merge({
        last_ledger: lastLedger,
        last_paging_token: lastPagingToken,
        updated_at: now,
      })
  }

  /**
   * Operator tool: set the checkpoint for a contract to an arbitrary ledger.
   * Used to rewind or fast-forward processing after an operational incident.
   * This is intentionally separate from `upsertCheckpoint` to make it obvious
   * at call-sites that a potentially backward write is occurring.
   */
  async resetCheckpoint(
    contractAddress: string,
    ledger: number,
    pagingToken: string | null = null,
  ): Promise<void> {
    const now = new Date()

    await this.db('horizon_checkpoints')
      .insert({
        contract_address: contractAddress,
        last_ledger: ledger,
        last_paging_token: pagingToken,
        updated_at: now,
        created_at: now,
      })
      .onConflict('contract_address')
      .merge({
        last_ledger: ledger,
        last_paging_token: pagingToken,
        updated_at: now,
      })
  }

  /**
   * Operator tool: remove the checkpoint for a contract entirely.
   * On next start the listener will begin from config.startLedger.
   */
  async deleteCheckpoint(contractAddress: string): Promise<void> {
    await this.db('horizon_checkpoints').where({ contract_address: contractAddress }).delete()
  }

  private mapRow(row: Record<string, unknown>): HorizonCheckpoint {
    return {
      id: row.id as number,
      contractAddress: row.contract_address as string,
      lastLedger: Number(row.last_ledger),
      lastPagingToken: (row.last_paging_token as string | null) ?? null,
      updatedAt: new Date(row.updated_at as string),
      createdAt: new Date(row.created_at as string),
    }
  }
}

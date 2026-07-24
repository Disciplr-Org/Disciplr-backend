/**
 * Migration: horizon_checkpoints
 *
 * Replaces the single-row listener_state table with a per-contract-address
 * checkpoint store.  Each row tracks the highest confirmed ledger and the
 * Horizon paging token for one contract address so the listener can resume
 * independently per contract after a restart.
 *
 * Idempotency guarantee: checkpoint writes are upserts (ON CONFLICT DO UPDATE),
 * so a crash between event commit and checkpoint commit only causes at-most one
 * re-delivery per contract, which the processed_events idempotency table absorbs.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('horizon_checkpoints', (table) => {
    table.increments('id').primary()

    // Unique per Soroban contract address being monitored.
    table.string('contract_address', 128).notNullable()

    // Last ledger sequence number successfully processed for this contract.
    table.bigInteger('last_ledger').notNullable()

    // Horizon SSE paging token matching last_ledger (may be null for seed rows).
    table.string('last_paging_token', 256).nullable()

    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('horizon_checkpoints', (table) => {
    table.unique(['contract_address'], { indexName: 'idx_horizon_checkpoints_contract' })
  })

  // Fast look-up by ledger (for lag-threshold monitoring).
  await knex.schema.alterTable('horizon_checkpoints', (table) => {
    table.index(['last_ledger'], 'idx_horizon_checkpoints_ledger')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('horizon_checkpoints')
}

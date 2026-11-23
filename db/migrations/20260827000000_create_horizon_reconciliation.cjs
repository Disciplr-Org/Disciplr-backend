/**
 * Durable state for the Horizon reconciliation worker.
 *
 * The listener's checkpoint answers "how far did the stream read?". This
 * state answers the stronger question "how far was authoritative state
 * confirmed and applied?". Keeping both avoids advancing a cursor past an
 * event that is still inside the confirmation window.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('horizon_reconciliation_state', table => {
    table.string('contract_address', 128).primary()
    table.bigInteger('confirmed_ledger').notNullable().defaultTo(0)
    table.bigInteger('scan_ledger').notNullable().defaultTo(0)
    table.string('paging_token', 256).nullable()
    table.timestamp('last_run_at', { useTz: true }).nullable()
    table.text('last_error').nullable()
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('horizon_reconciliation_events', table => {
    table.string('event_id', 128).primary()
    table.string('contract_address', 128).notNullable()
    table.string('vault_id', 128).notNullable()
    table.string('transaction_hash', 128).notNullable()
    table.bigInteger('ledger_number').notNullable()
    table.string('paging_token', 256).nullable()
    table.string('event_type', 64).notNullable()
    table.string('observed_status', 32).notNullable()
    table.string('confirmation_state', 32).notNullable()
    table.jsonb('payload').notNullable()
    table.timestamp('observed_at', { useTz: true }).notNullable()
    table.timestamp('updated_at', { useTz: true }).notNullable()
  })

  await knex.schema.alterTable('horizon_reconciliation_events', table => {
    table.index(['contract_address', 'ledger_number'], 'idx_reconciliation_events_contract_ledger')
    table.index(['vault_id', 'ledger_number'], 'idx_reconciliation_events_vault_ledger')
    table.index(['confirmation_state'], 'idx_reconciliation_events_confirmation')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('horizon_reconciliation_events')
  await knex.schema.dropTableIfExists('horizon_reconciliation_state')
}

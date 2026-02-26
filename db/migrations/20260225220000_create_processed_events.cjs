/**
 * Migration for processed_events table.
 * Stores event processing records for idempotency checking.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('processed_events', (table) => {
    table.string('event_id', 128).primary()
    table.string('transaction_hash', 64).notNullable()
    table.integer('event_index').notNullable()
    table.bigInteger('ledger_number').notNullable()
    table.timestamp('processed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('processed_events', (table) => {
    table.index(['transaction_hash'], 'idx_processed_events_transaction_hash')
    table.index(['processed_at'], 'idx_processed_events_processed_at')
    table.index(['ledger_number'], 'idx_processed_events_ledger_number')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('processed_events')
}

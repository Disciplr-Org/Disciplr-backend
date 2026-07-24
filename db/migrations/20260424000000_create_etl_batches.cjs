/**
 * Migration: create etl_batches table for idempotent ETL batch tracking.
 *
 * Each ETL run is assigned a UUID batch_id before it starts.  The table acts
 * as both a dedupe guard (UNIQUE on batch_id) and an audit log (status,
 * duration, counts, error).
 *
 * Idempotency contract:
 *   - A batch_id that already has status = 'completed' is a no-op on retry.
 *   - A batch_id with status = 'failed' may be retried (new row with same
 *     logical content but a fresh batch_id, or the caller reuses the same
 *     batch_id to resume – both patterns are supported).
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('etl_batches', (table) => {
    table.uuid('batch_id').primary()

    table
      .enu('status', ['pending', 'running', 'completed', 'failed'], {
        useNative: true,
        enumName: 'etl_batch_status',
      })
      .notNullable()
      .defaultTo('pending')

    // Counts populated on completion
    table.integer('operations_fetched').notNullable().defaultTo(0)
    table.integer('transactions_inserted').notNullable().defaultTo(0)
    table.integer('transactions_skipped').notNullable().defaultTo(0)

    // Timing
    table.timestamp('started_at', { useTz: true }).nullable()
    table.timestamp('finished_at', { useTz: true }).nullable()
    // Duration in milliseconds – derived but stored for cheap queries
    table.integer('duration_ms').nullable()

    // Error detail on failure
    table.text('error_message').nullable()

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('etl_batches', (table) => {
    table.index(['status'], 'idx_etl_batches_status')
    table.index(['created_at'], 'idx_etl_batches_created_at')
    table.index(['started_at'], 'idx_etl_batches_started_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('etl_batches')
  await knex.raw('DROP TYPE IF EXISTS etl_batch_status')
}

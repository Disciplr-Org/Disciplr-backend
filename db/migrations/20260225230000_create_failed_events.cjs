/**
 * Migration for failed_events table.
 * Stores events that failed processing after all retry attempts (dead letter queue).
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('failed_events', (table) => {
    table.increments('id').primary()
    table.string('event_id', 128).notNullable()
    table.jsonb('event_payload').notNullable()
    table.text('error_message').notNullable()
    table.integer('retry_count').notNullable().defaultTo(0)
    table.timestamp('failed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('failed_events', (table) => {
    table.index(['event_id'], 'idx_failed_events_event_id')
    table.index(['failed_at'], 'idx_failed_events_failed_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('failed_events')
}

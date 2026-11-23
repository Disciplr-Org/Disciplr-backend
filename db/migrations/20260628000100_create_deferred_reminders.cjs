/**
 * Migration for Deferred Reminders table
 * Stores reminders that are deferred due to quiet-hours windowing.
 * Reminders are processed when deliver_after timestamp is reached.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('deferred_reminders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('user_id', 255).notNullable()
    table.string('idempotency_key', 255).notNullable()
    table.jsonb('reminder_data').notNullable()
    table.timestamp('deliver_after', { useTz: true }).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.unique(['user_id', 'idempotency_key'], { indexName: 'uq_deferred_reminders_user_key' })
  })

  await knex.schema.alterTable('deferred_reminders', (table) => {
    table.index(['deliver_after'], 'idx_deferred_reminders_deliver_after')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('deferred_reminders')
}

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('webhook_dead_letters', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.uuid('subscriber_id').notNullable()
    table.text('event_id').notNullable()
    table.string('event_type', 128).notNullable()
    table.jsonb('payload').notNullable()
    table.text('last_error').notNullable()
    table.integer('attempts').notNullable().defaultTo(0)
    table.timestamp('failed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('replayed_at', { useTz: true }).nullable()
  })
  await knex.schema.raw(
    'CREATE INDEX idx_webhook_dlq_subscriber_failed ON webhook_dead_letters (subscriber_id, failed_at)',
  )
}

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('webhook_dead_letters')
}

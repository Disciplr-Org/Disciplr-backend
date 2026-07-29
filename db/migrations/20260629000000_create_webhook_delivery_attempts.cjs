/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('webhook_delivery_attempts')
  if (!exists) {
    await knex.schema.createTable('webhook_delivery_attempts', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
      table.uuid('subscriber_id').notNullable()
        .references('id').inTable('webhook_subscribers').onDelete('CASCADE')
      table.text('event_id').notNullable()
      table.string('event_type', 128).notNullable()
      table.integer('status_code').nullable()
      table.boolean('success').notNullable()
      table.integer('latency_ms').notNullable()
      table.text('error').nullable()
      table.integer('attempt_number').notNullable().defaultTo(1)
      table.timestamp('attempted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    })
    await knex.schema.raw(
      'CREATE INDEX idx_webhook_attempts_subscriber_time ON webhook_delivery_attempts (subscriber_id, attempted_at)',
    )
  }
}

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('webhook_delivery_attempts')
}

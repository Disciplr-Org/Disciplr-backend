exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('webhook_breaker_states')
  if (!exists) {
    await knex.schema.createTable('webhook_breaker_states', (table) => {
      table.uuid('subscriber_id').primary()
        .references('id').inTable('webhook_subscribers').onDelete('CASCADE')
      table.string('state', 10).notNullable().defaultTo('CLOSED')
      table.integer('failure_count').notNullable().defaultTo(0)
      table.timestamp('last_failure_at', { useTz: true }).nullable()
      table.timestamp('tripped_at', { useTz: true }).nullable()
      table.timestamp('half_open_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    })
  }
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('webhook_breaker_states')
}

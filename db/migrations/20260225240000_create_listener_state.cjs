/**
 * Migration for listener_state table.
 * Stores the ledger cursor for resumable operation after restarts.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('listener_state', (table) => {
    table.increments('id').primary()
    table.string('service_name', 64).notNullable()
    table.bigInteger('last_processed_ledger').notNullable()
    table.timestamp('last_processed_at', { useTz: true }).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('listener_state', (table) => {
    table.unique(['service_name'], 'idx_listener_state_service_name')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('listener_state')
}

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('webhook_replay_markers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.uuid('subscriber_id').notNullable()
      .references('id').inTable('webhook_subscribers').onDelete('CASCADE')
    table.string('replay_marker', 255).notNullable().unique()
    table.timestamp('start_time', { useTz: true }).notNullable()
    table.timestamp('end_time', { useTz: true }).notNullable()
    table.string('status', 32).notNullable().defaultTo('in_progress')
    table.integer('total_count').notNullable().defaultTo(0)
    table.integer('success_count').notNullable().defaultTo(0)
    table.integer('failure_count').notNullable().defaultTo(0)
    table.jsonb('errors').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('completed_at', { useTz: true }).nullable()
  })
}

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('webhook_replay_markers')
}

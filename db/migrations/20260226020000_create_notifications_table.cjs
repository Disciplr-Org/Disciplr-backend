/**
 * Migration for User Notifications table
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('notifications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('user_id', 255).notNullable()
    table.string('type', 100).notNullable()
    table.string('title', 255).notNullable()
    table.text('message').notNullable()
    table.jsonb('data').nullable()
    table.timestamp('read_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('notifications', (table) => {
    table.index(['user_id'], 'idx_notifications_user_id')
    table.index(['read_at'], 'idx_notifications_read_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('notifications')
}

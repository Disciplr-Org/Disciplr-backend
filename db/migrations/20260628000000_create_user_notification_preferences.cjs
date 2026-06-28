/**
 * Migration for User Notification Preferences table
 * Stores per-user quiet-hours and timezone preferences for notification delivery.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('user_notification_preferences', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('user_id', 255).notNullable().unique()
    table.string('timezone', 100).notNullable().defaultTo('UTC')
    table.boolean('quiet_hours_enabled').notNullable().defaultTo(false)
    table.time('quiet_hours_start').notNullable().defaultTo('22:00')
    table.time('quiet_hours_end').notNullable().defaultTo('08:00')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('user_notification_preferences', (table) => {
    table.index(['user_id'], 'idx_user_notification_prefs_user_id')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('user_notification_preferences')
}

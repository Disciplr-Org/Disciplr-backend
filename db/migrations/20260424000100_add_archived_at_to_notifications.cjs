/**
 * Add soft-delete archival support to notifications.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('notifications', (table) => {
    table.timestamp('archived_at', { useTz: true }).nullable()
  })

  await knex.schema.alterTable('notifications', (table) => {
    table.index(['user_id', 'archived_at', 'created_at'], 'idx_notifications_user_archived_created')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('notifications', (table) => {
    table.dropIndex(['user_id', 'archived_at', 'created_at'], 'idx_notifications_user_archived_created')
    table.dropColumn('archived_at')
  })
}

/**
 * Support keyset pagination for GET /api/notifications.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_archived_created_id
    ON notifications (user_id, archived_at, created_at DESC, id DESC)
  `)
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_notifications_user_archived_created_id')
}

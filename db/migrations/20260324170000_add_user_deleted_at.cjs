
/**
 * Add deletedAt column to users table for soft-delete support.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.timestamp('deleted_at', { useTz: true }).nullable()
    table.index(['deleted_at'], 'idx_users_deleted_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropIndex(['deleted_at'], 'idx_users_deleted_at')
    table.dropColumn('deleted_at')
  })
}

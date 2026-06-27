/**
 * Composite indexes for hot org/user-scoped list queries.
 *
 * Existing migrations already cover broad single-column and global performance
 * indexes. These indexes target stable paginated list access patterns that
 * filter by tenant/user scope and sort by recency plus id.
 */
exports.up = async function up(knex) {
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_vaults_org_created_id ON vaults (organization_id, created_at DESC, id DESC)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_vaults_org_status_created_id ON vaults (organization_id, status, created_at DESC, id DESC)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_vaults_org_creator_created_id ON vaults (organization_id, creator, created_at DESC, id DESC)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_transactions_user_stellar_id ON transactions (user_id, stellar_timestamp DESC, id DESC)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_transactions_user_vault_stellar_id ON transactions (user_id, vault_id, stellar_timestamp DESC, id DESC)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_transactions_user_type_stellar_id ON transactions (user_id, type, stellar_timestamp DESC, id DESC)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_notifications_user_created_id ON notifications (user_id, created_at DESC, id DESC)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created_id ON audit_logs (organization_id, created_at DESC, id DESC)',
  )
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_org_created_id')
  await knex.raw('DROP INDEX IF EXISTS idx_notifications_user_created_id')
  await knex.raw('DROP INDEX IF EXISTS idx_transactions_user_type_stellar_id')
  await knex.raw('DROP INDEX IF EXISTS idx_transactions_user_vault_stellar_id')
  await knex.raw('DROP INDEX IF EXISTS idx_transactions_user_stellar_id')
  await knex.raw('DROP INDEX IF EXISTS idx_vaults_org_creator_created_id')
  await knex.raw('DROP INDEX IF EXISTS idx_vaults_org_status_created_id')
  await knex.raw('DROP INDEX IF EXISTS idx_vaults_org_created_id')
}

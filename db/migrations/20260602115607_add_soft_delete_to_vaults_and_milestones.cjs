
/**
 * Documented no-op migration.
 *
 * This migration was historically recorded in production knex_migrations as empty.
 * The actual soft delete columns (deleted_at on vaults and milestones) are added
 * and dropped by 20260602125638_add_soft_delete_to_vaults_and_milestones.cjs.
 * It is preserved here as an explicit no-op so migration rollbacks and re-runs succeed
 * without modifying schema.
 */
exports.up = async function up(knex) {
  // Explicit no-op: actual columns are added in 20260602125638_add_soft_delete_to_vaults_and_milestones.cjs
};

exports.down = async function down(knex) {
  // Why this down changed:
  // Documented as explicit no-op because the actual rollback of deleted_at columns
  // is performed by 20260602125638_add_soft_delete_to_vaults_and_milestones.cjs.
};


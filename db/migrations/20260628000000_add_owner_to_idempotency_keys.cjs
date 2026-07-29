/**
 * Binds idempotency keys to their owning user / org so that cross-user key
 * reuse can be detected and rejected on replay.
 *
 * Existing keys receive NULL for both columns, which the service treats as
 * "legacy / anonymous" and allows any caller to replay (backward compat).
 */
exports.up = async function up(knex) {
  const hasUserId = await knex.schema.hasColumn('idempotency_keys', 'user_id')
  const hasOrgId = await knex.schema.hasColumn('idempotency_keys', 'org_id')

  if (!hasUserId || !hasOrgId) {
    await knex.schema.alterTable('idempotency_keys', (table) => {
      if (!hasUserId) table.string('user_id', 255).nullable()
      if (!hasOrgId) table.string('org_id', 255).nullable()
    })
  }

  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user_id ON idempotency_keys (user_id)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_org_id ON idempotency_keys (org_id)',
  )
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_idempotency_keys_user_id')
  await knex.raw('DROP INDEX IF EXISTS idx_idempotency_keys_org_id')

  await knex.schema.alterTable('idempotency_keys', (table) => {
    table.dropColumn('user_id')
    table.dropColumn('org_id')
  })
}

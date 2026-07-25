/**
 * Add nullable organization_id column and composite index for admin-scoped queries
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('audit_logs')
  if (!hasTable) return

  // Add organization_id column if missing
  const hasColumn = await knex.schema.hasColumn('audit_logs', 'organization_id')
  if (!hasColumn) {
    await knex.schema.alterTable('audit_logs', (table) => {
      table.uuid('organization_id').nullable().comment('Optional organization association for multi-tenant audit queries')
    })
  }

  // Create composite index to support WHERE organization_id = ? ORDER BY created_at DESC
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_organization_created ON audit_logs (organization_id, created_at DESC)`,
  )
}

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('audit_logs')
  if (!hasTable) return

  await knex.raw(`DROP INDEX IF EXISTS idx_audit_logs_organization_created`)

  const hasColumn = await knex.schema.hasColumn('audit_logs', 'organization_id')
  if (hasColumn) {
    await knex.schema.alterTable('audit_logs', (table) => {
      table.dropColumn('organization_id')
    })
  }
}

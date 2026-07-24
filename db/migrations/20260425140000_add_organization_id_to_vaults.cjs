/**
 * Add organization_id to vaults table for enterprise authorization.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('vaults', (table) => {
    table.uuid('organization_id').nullable().references('id').inTable('organizations').onDelete('SET NULL')
    table.index(['organization_id'], 'idx_vaults_organization_id')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('vaults', (table) => {
    table.dropIndex(['organization_id'], 'idx_vaults_organization_id')
    table.dropColumn('organization_id')
  })
}

/**
 * Adds explicit revocation state for pending organization invitations.
 *
 * A revoked invitation remains auditable, but acceptance queries ignore it.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('org_invitations', (table) => {
    table.timestamp('revoked_at', { useTz: true }).nullable()
    table.index(['org_id', 'revoked_at'], 'idx_org_invitations_org_revoked_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('org_invitations', (table) => {
    table.dropIndex(['org_id', 'revoked_at'], 'idx_org_invitations_org_revoked_at')
    table.dropColumn('revoked_at')
  })
}

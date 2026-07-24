/**
 * Migration: org_invitations
 *
 * Stores one-time invitation tokens for org membership.
 * The raw token is never persisted; only its SHA-256 hash is stored.
 * Acceptance sets accepted_at; expired or already-accepted rows are rejected
 * by the route handler.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('org_invitations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.uuid('org_id').notNullable()
    table.string('email', 320).notNullable()
    table.string('token_hash', 64).notNullable()
    table.timestamp('expires_at', { useTz: true }).notNullable()
    table.timestamp('accepted_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.unique(['token_hash'], { indexName: 'idx_org_invitations_token_hash' })
    table.index(['org_id'], 'idx_org_invitations_org_id')
    table.index(['email'], 'idx_org_invitations_email')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('org_invitations')
}

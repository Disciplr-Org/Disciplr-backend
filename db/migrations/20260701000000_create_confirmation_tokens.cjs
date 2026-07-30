/**
 * Migration: confirmation_tokens
 *
 * Stores dual-control confirmation tokens for destructive admin actions.
 * Previously stored in a process-local Map, which broke multi-instance deployments.
 * See issue #1033.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('confirmation_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('token_id', 36).notNullable().unique()
    table.string('user_id', 255).notNullable()
    table.string('action', 255).notNullable()
    table.string('scope', 255).nullable()
    table.timestamp('expires_at', { useTz: true }).notNullable()
    table.boolean('used').notNullable().defaultTo(false)
    table.boolean('dual_control_required').notNullable().defaultTo(false)
    table.string('approved_by', 255).nullable()
    table.timestamp('approved_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['token_id'], 'idx_confirmation_tokens_token_id')
    table.index(['user_id'], 'idx_confirmation_tokens_user_id')
    table.index(['expires_at'], 'idx_confirmation_tokens_expires_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('confirmation_tokens')
}

/**
 * Migration to create the sessions table for token revocation and session management.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('user_id', 255).notNullable()
    table.string('jti', 255).notNullable().unique()
    table.timestamp('revoked_at', { useTz: true }).nullable()
    table.timestamp('expires_at', { useTz: true }).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('sessions', (table) => {
    table.index(['user_id'], 'idx_sessions_user_id')
    table.index(['jti'], 'idx_sessions_jti')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sessions')
}

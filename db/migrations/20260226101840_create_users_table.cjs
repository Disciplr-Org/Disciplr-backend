
/**
 * Create users table for authentication and transaction ownership.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('email', 255).unique().notNullable()
    table.string('password_hash', 255).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('users', (table) => {
    table.index(['email'], 'idx_users_email')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('users')
}

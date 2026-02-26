exports.up = async function up(knex) {
  // Ensure UUID helper is available
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  // Create verifier status enum and table
  await knex.schema.createTable('verifiers', (table) => {
    table.string('user_id', 255).primary()
    table.string('display_name', 255)
    table.jsonb('metadata')
    table
      .enu('status', ['pending', 'approved', 'suspended'], {
        useNative: true,
        enumName: 'verifier_status',
      })
      .notNullable()
      .defaultTo('pending')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('approved_at', { useTz: true })
    table.timestamp('suspended_at', { useTz: true })
  })

  await knex.schema.alterTable('verifiers', (table) => {
    table.index(['status'], 'idx_verifiers_status')
  })

  // Create verification records
  await knex.schema.createTable('verifications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('verifier_user_id', 255).notNullable()
    table.string('target_id', 1024).notNullable()
    table
      .enu('result', ['approved', 'rejected'], {
        useNative: true,
        enumName: 'verification_result',
      })
      .notNullable()
    table.boolean('disputed').notNullable().defaultTo(false)
    table.timestamp('timestamp', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.foreign('verifier_user_id').references('user_id').inTable('verifiers').onDelete('CASCADE')
  })

  await knex.schema.alterTable('verifications', (table) => {
    table.index(['verifier_user_id'], 'idx_verifications_verifier')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('verifications')
  await knex.raw('DROP TYPE IF EXISTS verification_result')
  await knex.schema.dropTableIfExists('verifiers')
  await knex.raw('DROP TYPE IF EXISTS verifier_status')
}

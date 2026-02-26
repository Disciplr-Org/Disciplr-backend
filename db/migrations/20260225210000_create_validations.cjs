/**
 * Migration for validations table.
 * Stores validation records for milestone verification.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('validations', (table) => {
    table.string('id', 64).primary()
    table.string('milestone_id', 64).notNullable()
    table.string('validator_address', 255).notNullable()
    table
      .enu('validation_result', ['approved', 'rejected', 'pending_review'], {
        useNative: true,
        enumName: 'validation_result',
      })
      .notNullable()
    table.string('evidence_hash', 255)
    table.timestamp('validated_at', { useTz: true }).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.foreign('milestone_id').references('id').inTable('milestones').onDelete('CASCADE')
  })

  await knex.schema.alterTable('validations', (table) => {
    table.index(['milestone_id'], 'idx_validations_milestone_id')
    table.index(['validator_address'], 'idx_validations_validator_address')
    table.index(['validated_at'], 'idx_validations_validated_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('validations')
  await knex.raw('DROP TYPE IF EXISTS validation_result')
}

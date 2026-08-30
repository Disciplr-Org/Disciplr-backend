/**
 * Durable state for milestone release/redirect operations.
 *
 * The operation identity is supplied by the caller and is unique per
 * milestone. This lets a retried request recover the original operation
 * instead of creating a second payout attempt.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('settlement_operations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('milestone_id', 64).notNullable()
      .references('id').inTable('milestones').onDelete('CASCADE')
    table.string('operation_key', 255).notNullable()
    table
      .enu('operation_type', ['release', 'redirect'], {
        useNative: true,
        enumName: 'settlement_operation_type',
      })
      .notNullable()
    table
      .enu('status', ['pending', 'submitted', 'confirmed', 'failed'], {
        useNative: true,
        enumName: 'settlement_operation_status',
      })
      .notNullable()
      .defaultTo('pending')
    table.integer('attempt_count').notNullable().defaultTo(0)
    table.string('transaction_hash', 128).nullable()
    table.string('failure_code', 64).nullable()
    table.text('failure_message').nullable()
    table.string('requested_by', 255).notNullable()
    table.jsonb('request_fingerprint').notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('submitted_at', { useTz: true }).nullable()
    table.timestamp('confirmed_at', { useTz: true }).nullable()

    table.unique(['milestone_id', 'operation_key'], {
      indexName: 'idx_settlement_operations_identity',
    })
    table.unique(['transaction_hash'], {
      indexName: 'idx_settlement_operations_transaction_hash',
    })
    table.index(['milestone_id', 'status'], 'idx_settlement_operations_milestone_status')
    table.index(['status', 'updated_at'], 'idx_settlement_operations_recovery')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('settlement_operations')
  await knex.raw('DROP TYPE IF EXISTS settlement_operation_status')
  await knex.raw('DROP TYPE IF EXISTS settlement_operation_type')
}


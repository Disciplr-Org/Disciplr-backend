exports.config = { transaction: false }

exports.up = async function up(knex) {
  await knex.raw("ALTER TYPE milestone_status ADD VALUE IF NOT EXISTS 'approved'")

  await knex.schema.alterTable('settlement_operations', (table) => {
    table.string('milestone_id', 64).nullable().alter()
    table.string('vault_id', 64).nullable()
      .references('id').inTable('vaults').onDelete('CASCADE')
    table.string('target_milestone_id', 64).nullable()
  })

  await knex.raw(`
    ALTER TABLE settlement_operations
    ADD CONSTRAINT settlement_operations_exactly_one_scope
    CHECK ((milestone_id IS NOT NULL) <> (vault_id IS NOT NULL))
  `)

  await knex.schema.alterTable('settlement_operations', (table) => {
    table.unique(['vault_id', 'operation_key'], {
      indexName: 'idx_settlement_operations_vault_identity',
    })
    table.index(['vault_id', 'status'], 'idx_settlement_operations_vault_status')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('settlement_operations', (table) => {
    table.dropIndex(['vault_id', 'status'], 'idx_settlement_operations_vault_status')
    table.dropUnique(['vault_id', 'operation_key'], 'idx_settlement_operations_vault_identity')
  })
  await knex.raw('ALTER TABLE settlement_operations DROP CONSTRAINT IF EXISTS settlement_operations_exactly_one_scope')
  await knex.schema.alterTable('settlement_operations', (table) => {
    table.dropColumn('vault_id')
    table.dropColumn('target_milestone_id')
    table.string('milestone_id', 64).notNullable().alter()
  })
}

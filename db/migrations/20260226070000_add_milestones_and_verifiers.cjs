/**
 * Add milestones and multi-verifier support
 */
exports.up = async function up(knex) {
  // Create milestones table
  await knex.schema.createTable('milestones', (table) => {
    table.string('id', 64).primary()
    table.string('vault_id', 64).notNullable().references('id').inTable('vaults').onDelete('CASCADE')
    table.string('title', 255).notNullable()
    table.text('description')
    table.timestamp('deadline', { useTz: true }).notNullable()
    table
      .enu('status', ['pending', 'approved', 'rejected', 'expired'], {
        useNative: true,
        enumName: 'milestone_status',
      })
      .notNullable()
      .defaultTo('pending')
    table
      .enu('approval_policy', ['all', 'majority'], {
        useNative: true,
        enumName: 'approval_policy',
      })
      .notNullable()
      .defaultTo('all')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  // Create verifiers table
  await knex.schema.createTable('verifiers', (table) => {
    table.string('id', 64).primary()
    table.string('name', 255).notNullable()
    table.string('email', 255).unique().notNullable()
    table.string('wallet_address', 255).unique()
    table.boolean('active').notNullable().defaultTo(true)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  // Create milestone_verifiers join table
  await knex.schema.createTable('milestone_verifiers', (table) => {
    table.string('id', 64).primary()
    table.string('milestone_id', 64).notNullable().references('id').inTable('milestones').onDelete('CASCADE')
    table.string('verifier_id', 64).notNullable().references('id').inTable('verifiers').onDelete('CASCADE')
    table
      .enu('decision', ['pending', 'approved', 'rejected'], {
        useNative: true,
        enumName: 'verifier_decision',
      })
      .notNullable()
      .defaultTo('pending')
    table.text('reason')
    table.timestamp('decided_at', { useTz: true })
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    
    // Ensure unique milestone-verifier combination
    table.unique(['milestone_id', 'verifier_id'])
  })

  // Add indexes
  await knex.schema.alterTable('milestones', (table) => {
    table.index(['vault_id'], 'idx_milestones_vault_id')
    table.index(['status'], 'idx_milestones_status')
    table.index(['deadline'], 'idx_milestones_deadline')
  })

  await knex.schema.alterTable('verifiers', (table) => {
    table.index(['active'], 'idx_verifiers_active')
    table.index(['email'], 'idx_verifiers_email')
  })

  await knex.schema.alterTable('milestone_verifiers', (table) => {
    table.index(['milestone_id'], 'idx_milestone_verifiers_milestone_id')
    table.index(['verifier_id'], 'idx_milestone_verifiers_verifier_id')
    table.index(['decision'], 'idx_milestone_verifiers_decision')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('milestone_verifiers')
  await knex.schema.dropTableIfExists('verifiers')
  await knex.schema.dropTableIfExists('milestones')
  await knex.raw('DROP TYPE IF EXISTS milestone_status')
  await knex.raw('DROP TYPE IF EXISTS approval_policy')
  await knex.raw('DROP TYPE IF EXISTS verifier_decision')
}

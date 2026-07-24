/**
 * Migration: Add multi-verifier threshold support to milestones
 * 
 * Changes:
 * 1. Adds approval_threshold column to milestones (M-of-N threshold)
 * 2. Creates milestone_approvals table to track distinct verifier approvals
 * 3. Ensures single-vote-per-verifier with unique constraint
 */
exports.up = async function up(knex) {
  // Add approval_threshold column to milestones (default 1 for backward compatibility)
  await knex.schema.alterTable('milestones', (table) => {
    table.integer('approval_threshold').notNullable().defaultTo(1).comment('M in M-of-N threshold')
    table.index(['approval_threshold'], 'idx_milestones_approval_threshold')
  })

  // Create milestone_approvals tracking table
  await knex.schema.createTable('milestone_approvals', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('milestone_id', 64).notNullable()
    table.string('verifier_user_id', 255).notNullable()
    table
      .enu('approval_status', ['pending', 'approved', 'rejected'], {
        useNative: true,
        enumName: 'milestone_approval_status',
      })
      .notNullable()
      .defaultTo('pending')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    // Foreign keys
    table.foreign('milestone_id').references('id').inTable('milestones').onDelete('CASCADE')
    table.foreign('verifier_user_id').references('user_id').inTable('verifiers').onDelete('CASCADE')

    // Ensure single vote per verifier per milestone
    table.unique(['milestone_id', 'verifier_user_id'], { indexName: 'idx_milestone_approvals_unique' })
  })

  // Create indexes for efficient queries
  await knex.schema.alterTable('milestone_approvals', (table) => {
    table.index(['milestone_id'], 'idx_milestone_approvals_milestone_id')
    table.index(['verifier_user_id'], 'idx_milestone_approvals_verifier_user_id')
    table.index(['approval_status'], 'idx_milestone_approvals_status')
    table.index(['milestone_id', 'approval_status'], 'idx_milestone_approvals_milestone_status')
  })
}

exports.down = async function down(knex) {
  // Drop milestone_approvals table
  await knex.schema.dropTableIfExists('milestone_approvals')
  await knex.raw('DROP TYPE IF EXISTS milestone_approval_status')

  // Remove approval_threshold column
  await knex.schema.alterTable('milestones', (table) => {
    table.dropIndex([], 'idx_milestones_approval_threshold')
    table.dropColumn('approval_threshold')
  })
}

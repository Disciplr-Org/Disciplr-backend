/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.schema.createTable('milestones', (table) => {
    // Primary key
    table.string('id', 64).primary();
    
    // Foreign key matching the vaults table ID format
    table.string('vault_id', 64)
      .notNullable()
      .references('id')
      .inTable('vaults')
      .onDelete('CASCADE')
      .onUpdate('CASCADE');

    table.string('title', 255).notNullable();
    table.text('description');
    table.string('type', 100).notNullable();
    
    // JSONB is ideal for storing flexible criteria (hash/document/oracle/verifier)
    table.jsonb('criteria').notNullable();
    
    table.integer('weight').notNullable().defaultTo(0);
    table.timestamp('due_date', { useTz: true });
    
    // Status enum mimicking the style used in the baseline migration
    table.enu('status', ['pending', 'submitted', 'approved', 'rejected'], {
        useNative: true,
        enumName: 'milestone_status'
    }).notNullable().defaultTo('pending');

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Indexes to optimize repository list queries
  await knex.schema.alterTable('milestones', (table) => {
    table.index(['vault_id'], 'idx_milestones_vault_id');
    table.index(['status'], 'idx_milestones_status');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  // Drop table, then drop the custom enum type
  await knex.schema.dropTableIfExists('milestones');
  await knex.raw('DROP TYPE IF EXISTS milestone_status');
};
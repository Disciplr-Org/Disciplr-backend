
/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Create audit_logs table
  await knex.schema.createTable('audit_logs', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('actor_user_id').notNullable();
    table.string('action').notNullable();
    table.string('target_type').notNullable();
    table.string('target_id').notNullable();
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.raw('NOW()'));
    
    // Performance indexes for common query patterns
    table.index(['actor_user_id'], 'idx_audit_logs_actor_user_id');
    table.index(['action'], 'idx_audit_logs_action');
    table.index(['target_type'], 'idx_audit_logs_target_type');
    table.index(['target_id'], 'idx_audit_logs_target_id');
    table.index(['created_at'], 'idx_audit_logs_created_at');
    
    // Composite indexes for common filter combinations
    table.index(['actor_user_id', 'created_at'], 'idx_audit_logs_actor_created');
    table.index(['action', 'created_at'], 'idx_audit_logs_action_created');
    table.index(['target_type', 'target_id'], 'idx_audit_logs_target');
    
    // Add comments for documentation
    table.comment('Audit log entries tracking all system actions for compliance and security');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('audit_logs');
};

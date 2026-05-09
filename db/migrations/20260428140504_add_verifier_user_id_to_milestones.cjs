
exports.up = function(knex) {
  return knex.schema.alterTable('milestones', (table) => {
    table.string('verifier_user_id', 255).references('user_id').inTable('verifiers').onDelete('SET NULL');
    table.index(['verifier_user_id'], 'idx_milestones_verifier_user_id');
  });
};

exports.down = function(knex) {
  return knex.schema.alterTable('milestones', (table) => {
    table.dropIndex(['verifier_user_id'], 'idx_milestones_verifier_user_id');
    table.dropColumn('verifier_user_id');
  });
};

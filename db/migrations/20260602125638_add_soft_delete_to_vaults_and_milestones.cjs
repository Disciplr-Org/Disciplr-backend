exports.up = function(knex) {
  return knex.schema
    .alterTable('vaults', function(table) {
      table.timestamp('deleted_at').nullable();
    })
    .alterTable('milestones', function(table) {
      table.timestamp('deleted_at').nullable();
    });
};

exports.down = function(knex) {
  return knex.schema
    .alterTable('vaults', function(table) {
      table.dropColumn('deleted_at');
    })
    .alterTable('milestones', function(table) {
      table.dropColumn('deleted_at');
    });
};

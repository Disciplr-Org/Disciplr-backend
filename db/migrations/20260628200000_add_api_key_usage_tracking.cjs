exports.up = async function up(knex) {
  await knex.schema.alterTable('api_keys', (table) => {
    table.timestamp('last_used_at', { useTz: true });
    table.integer('request_count').notNullable().defaultTo(0);
    table.text('last_ip');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('api_keys', (table) => {
    table.dropColumn('last_used_at');
    table.dropColumn('request_count');
    table.dropColumn('last_ip');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('feature_flags', (table) => {
    table.decimal('rollout_percentage', 5, 2).nullable()
    table.json('rules').nullable()
  })
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('feature_flags', (table) => {
    table.dropColumn('rules')
    table.dropColumn('rollout_percentage')
  })
}

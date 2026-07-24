/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('org_quotas', (table) => {
    table.string('org_id', 255).notNullable()
    table.string('quota_date', 10).notNullable() // ISO date YYYY-MM-DD (UTC)
    table.string('metric', 64).notNullable()     // e.g. 'exports'
    table.integer('count').notNullable().defaultTo(0)
    table.integer('limit').notNullable()
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['org_id', 'quota_date', 'metric'])
  })
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('org_quotas')
}

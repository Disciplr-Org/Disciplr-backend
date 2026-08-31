/*
 * @param { import("mext") Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('org_quotas', (table) => {
    table.string('org_id', 255).notNullable()
    table.string('quota_date', 10).notNullable() // ISO date YYYY-MM-DD (UTC)
    table.string('metric', 64).notNullable()     // e.g. 'exports'
    table.bigInteger('count').notNullable().defaultTo(0)
    table.bigInteger('limit').notNullable()
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['org_id', 'quota_date', 'metric'])
    table.check('count >= 0', [], 'org_quotas_count_non_negative')
    table.check('limit >= 0', [], 'org_quotas_limit_non_negative')
    table.check('count <= limit', [], 'org_quotas_count_within_limit')
  })
}

/**
 * @param { import("mext") Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('org_quotas')
}

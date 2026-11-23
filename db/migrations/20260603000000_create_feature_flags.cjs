/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // Create feature_flags table for org-aware feature gating
  await knex.schema.createTable('feature_flags', (table) => {
    // Surrogate PK — org_id is nullable so it cannot participate in a PRIMARY KEY.
    table.increments('id').primary()

    // Feature flag name (e.g., 'ENTERPRISE_ANALYTICS', 'MULTI_VERIFIER_ENABLED')
    table.string('name', 128).notNullable()

    // Organization ID - null means global/default flag
    // Allows per-org overrides of global settings
    table.string('org_id', 255).nullable()

    // Whether this flag is enabled
    table.boolean('enabled').notNullable().defaultTo(false)

    // When the flag was last updated
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    // Unique constraint: one entry per flag per org
    // PostgreSQL treats NULLs as distinct in UNIQUE, so global flags (org_id = NULL) work correctly.
    table.unique(['name', 'org_id'])

    // Index on org_id for efficient lookups when fetching all flags for an org
    table.index(['org_id'])

    // Index on updated_at for queries ordering by recency
    table.index(['updated_at'])
  })

  // Seed with default flags (all disabled by default)
  await knex('feature_flags').insert([
    { name: 'ENTERPRISE_ANALYTICS', org_id: null, enabled: false },
    { name: 'MULTI_VERIFIER_ENABLED', org_id: null, enabled: false },
    { name: 'ORGANIZATION_QUOTAS', org_id: null, enabled: false },
    { name: 'ADVANCED_ANALYTICS', org_id: null, enabled: false },
  ])
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('feature_flags')
}

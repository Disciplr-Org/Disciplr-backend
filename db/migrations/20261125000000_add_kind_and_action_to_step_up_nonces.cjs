exports.up = async function up(knex) {
  return knex.raw(`
    ALTER TABLE "step_up_nonces"
      ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'challenge',
      ADD COLUMN IF NOT EXISTS "action" TEXT;
  `)
}

exports.down = async function down(knex) {
  return knex.raw(`
    ALTER TABLE "step_up_nonces"
      DROP COLUMN IF EXISTS "action",
      DROP COLUMN IF EXISTS "kind";
  `)
}

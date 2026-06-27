exports.up = async function up(knex) {
  return knex.raw(`
    ALTER TABLE "webauthn_credentials"
      ADD COLUMN IF NOT EXISTS "sign_count" INTEGER NOT NULL DEFAULT 0;
  `)
}

exports.down = async function down(knex) {
  return knex.raw(`
    ALTER TABLE "webauthn_credentials"
      DROP COLUMN IF EXISTS "sign_count";
  `)
}

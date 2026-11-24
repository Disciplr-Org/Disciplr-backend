exports.up = async function up(knex) {
  return knex.raw(`
    CREATE TABLE IF NOT EXISTS "step_up_nonces" (
      "nonce" TEXT PRIMARY KEY,
      "user_id" UUID NOT NULL,
      "expires_at" TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS "idx_step_up_nonces_expires_at"
      ON "step_up_nonces" ("expires_at");
  `)
}

exports.down = async function down(knex) {
  return knex.raw(`
    DROP INDEX IF EXISTS "idx_step_up_nonces_expires_at";
    DROP TABLE IF EXISTS "step_up_nonces";
  `)
}

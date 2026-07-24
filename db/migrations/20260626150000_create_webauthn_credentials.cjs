exports.up = async function up(knex) {
  return knex.raw(`
    CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" UUID NOT NULL,
      "credential_id" TEXT NOT NULL UNIQUE,
      "public_key" TEXT NOT NULL,
      "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "last_used_at" TIMESTAMP NULL
    );

    CREATE INDEX IF NOT EXISTS "idx_webauthn_credentials_user_id"
      ON "webauthn_credentials" ("user_id");
  `)
}

exports.down = async function down(knex) {
  return knex.raw(`
    DROP INDEX IF EXISTS "idx_webauthn_credentials_user_id";
    DROP TABLE IF EXISTS "webauthn_credentials";
  `)
}

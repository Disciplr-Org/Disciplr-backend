/**
 * Migration: create rate_limit_buckets table for serverless rate limiting.
 * Keyed by key (e.g. IP or Stellar address) and window_start timestamp.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      key text NOT NULL,
      window_start timestamptz NOT NULL,
      count int NOT NULL DEFAULT 1,
      PRIMARY KEY (key, window_start)
    )
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_window_start
    ON rate_limit_buckets (window_start)
  `)
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('rate_limit_buckets')
}

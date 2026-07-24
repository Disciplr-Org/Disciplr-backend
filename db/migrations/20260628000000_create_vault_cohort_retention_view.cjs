/**
 * Adds a materialized view for monthly vault creation cohorts, answering
 * "of vaults created in month M, what fraction completed within N weeks".
 *
 * Columns: cohort_month, total, completed, failed, active, median_days_to_complete
 *
 * Note on median_days_to_complete:
 *   `vaults` has no dedicated completed_at column. Both status-transition
 *   paths (eventProcessor.handleVaultEvent and vaultTransitions.transitionVaultStatus)
 *   set `updated_at = now()` in the same statement that flips status to a
 *   terminal value, so updated_at is used as the completion timestamp.
 *   median_days_to_complete is NULL for any cohort with zero completed vaults.
 *
 * A unique index on cohort_month is required so the refresh job can use
 * REFRESH MATERIALIZED VIEW CONCURRENTLY (avoids locking reads during refresh).
 */

const VIEW_NAME = "vault_cohort_retention";
const INDEX_NAME = "idx_vault_cohort_retention_month";

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function up(knex) {
  await knex.schema.raw(`
    CREATE MATERIALIZED VIEW ${VIEW_NAME} AS
    SELECT
      date_trunc('month', created_at)::date AS cohort_month,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0
      ) FILTER (WHERE status = 'completed') AS median_days_to_complete
    FROM vaults
    GROUP BY date_trunc('month', created_at)
    WITH DATA
  `);

  await knex.schema.raw(`
    CREATE UNIQUE INDEX ${INDEX_NAME} ON ${VIEW_NAME} (cohort_month)
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function down(knex) {
  await knex.schema.raw(`DROP MATERIALIZED VIEW IF EXISTS ${VIEW_NAME}`);
};

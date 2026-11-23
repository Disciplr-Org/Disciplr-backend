import db from "../db/index.js";
import type { Knex } from "knex";

/**
 * A single row from the vault_cohort_retention materialized view.
 *
 * NOTE: the view (see db/migrations/*_create_vault_cohort_retention_view.cjs)
 * exposes `cohort_month`, `total`, `completed`, `failed`, `active` and
 * `median_days_to_complete`. The API contract below uses different names, so
 * the query aliases the view columns onto those names — keep the two in sync.
 */
export interface CohortRetentionRow {
  /** The cohort period label, e.g. "2024-01" (view: cohort_month) */
  cohort_period: string;
  /** Number of users/vaults that entered the cohort (view: total) */
  cohort_size: number;
  /** Number that completed out of the cohort (view: completed) */
  retained_count: number;
  /** Retention rate as a fraction [0, 1] — completed / total */
  retention_rate: number;
}

/**
 * Result returned by getCohortRetention.
 */
export interface CohortRetentionResult {
  cohorts: CohortRetentionRow[];
  range: number | null;
  generatedAt: string;
}

/**
 * Read retention data from the vault_cohort_retention materialized view.
 *
 * @param queryRunner - Knex instance (injectable for tests).
 * @param range       - Optional number of most-recent cohort periods to return.
 *                      When omitted, all rows are returned.
 */
export const getCohortRetention = async (
  queryRunner: Pick<Knex, "raw"> = db,
  range?: number,
): Promise<CohortRetentionResult> => {
  const limitClause =
    typeof range === "number" && range > 0 ? `LIMIT ${range}` : "";

  // The view's real columns are cohort_month / total / completed. Selecting the
  // API-facing names (cohort_period / cohort_size / retained_count /
  // retention_rate) directly raised `column ... does not exist`, so alias the
  // view columns onto the contract instead. Keep this list in sync with the
  // migration that creates vault_cohort_retention.
  const sql = `
    SELECT
      to_char(cohort_month, 'YYYY-MM') AS cohort_period,
      total AS cohort_size,
      completed AS retained_count,
      CASE WHEN total > 0 THEN completed::float / total ELSE 0 END AS retention_rate
    FROM vault_cohort_retention
    ORDER BY cohort_month DESC
    ${limitClause}
  `;

  const raw = await queryRunner.raw(sql);

  // pg driver returns { rows: [...] }; some test runners return the array directly.
  const rows: CohortRetentionRow[] =
    (raw as { rows: CohortRetentionRow[] }).rows ??
    (raw as CohortRetentionRow[]);

  return {
    cohorts: rows.map((r) => ({
      cohort_period: String(r.cohort_period),
      cohort_size: Number(r.cohort_size),
      retained_count: Number(r.retained_count),
      retention_rate: Number(r.retention_rate),
    })),
    range: typeof range === "number" && range > 0 ? range : null,
    generatedAt: new Date().toISOString(),
  };
};

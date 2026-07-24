import db from "../db/index.js";
import type { Knex } from "knex";

/**
 * A single row from the vault_cohort_retention materialized view.
 */
export interface CohortRetentionRow {
  /** The cohort period label, e.g. "2024-01" */
  cohort_period: string;
  /** Number of users/vaults that entered the cohort */
  cohort_size: number;
  /** Number still active / retained */
  retained_count: number;
  /** Retention rate as a fraction [0, 1] */
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

  const sql = `
    SELECT
      cohort_period,
      cohort_size,
      retained_count,
      retention_rate
    FROM vault_cohort_retention
    ORDER BY cohort_period DESC
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

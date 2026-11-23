import type { Knex } from "knex";
import db from "../db/index.js";

export interface OrgAnalyticsTeamPerformance {
  creator: string;
  vaultCount: number;
  totalAmount: string;
  successRate: number;
}

export interface OrgAnalyticsResult {
  orgId: string;
  analytics: {
    totalCapital: string;
    successRate: number;
    activeVaults: number;
    completedVaults: number;
    failedVaults: number;
  };
  teamPerformance: OrgAnalyticsTeamPerformance[];
  generatedAt: string;
}

type TotalsRow = {
  total_capital: string | number;
  active_vaults: string | number;
  completed_vaults: string | number;
  failed_vaults: string | number;
};

type CreatorRow = {
  creator: string;
  vault_count: string | number;
  total_amount: string | number;
  completed_vaults: string | number;
  failed_vaults: string | number;
};

const ORG_TOTALS_SQL = `
SELECT
  COALESCE(SUM(amount::numeric), 0) AS total_capital,
  COUNT(*) FILTER (WHERE status = 'active') AS active_vaults,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed_vaults,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed_vaults
FROM vaults
WHERE organization_id = ?
  AND deleted_at IS NULL
`;

const CREATOR_STATS_SQL = `
SELECT
  creator,
  COUNT(*) AS vault_count,
  COALESCE(SUM(amount::numeric), 0) AS total_amount,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed_vaults,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed_vaults
FROM vaults
WHERE organization_id = ?
  AND deleted_at IS NULL
GROUP BY creator
ORDER BY creator ASC
`;

function unwrapRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows)) {
    return (raw as { rows: T[] }).rows;
  }
  return [];
}

function successRate(completed: number, failed: number): number {
  const resolved = completed + failed;
  return resolved > 0 ? completed / resolved : 0;
}

/**
 * Org-level vault analytics sourced entirely from Postgres.
 * Mirrors the SQL-aggregation style of getTeamRollup so production never
 * depends on the never-populated in-memory vaults array.
 */
export const getOrgAnalytics = async (
  orgId: string,
  queryRunner: Pick<Knex, "raw"> = db,
): Promise<OrgAnalyticsResult> => {
  const [totalsRaw, creatorRaw] = await Promise.all([
    queryRunner.raw(ORG_TOTALS_SQL, [orgId]),
    queryRunner.raw(CREATOR_STATS_SQL, [orgId]),
  ]);

  const totalsRows = unwrapRows<TotalsRow>(totalsRaw);
  const totals = totalsRows[0] ?? {
    total_capital: 0,
    active_vaults: 0,
    completed_vaults: 0,
    failed_vaults: 0,
  };

  const completedVaults = Number(totals.completed_vaults);
  const failedVaults = Number(totals.failed_vaults);

  const teamPerformance: OrgAnalyticsTeamPerformance[] = unwrapRows<CreatorRow>(
    creatorRaw,
  ).map((row) => {
    const completed = Number(row.completed_vaults);
    const failed = Number(row.failed_vaults);
    return {
      creator: String(row.creator),
      vaultCount: Number(row.vault_count),
      totalAmount: Number(row.total_amount).toString(),
      successRate: successRate(completed, failed),
    };
  });

  return {
    orgId,
    analytics: {
      totalCapital: Number(totals.total_capital).toString(),
      successRate: successRate(completedVaults, failedVaults),
      activeVaults: Number(totals.active_vaults),
      completedVaults,
      failedVaults,
    },
    teamPerformance,
    generatedAt: new Date().toISOString(),
  };
};

/**
 * Load org-scoped vault rows from the database for risk analytics.
 * Soft-deleted vaults are excluded; shapes match OrgRiskAnalyticsVault.
 */
export const listOrgVaultsForRiskAnalytics = async (
  orgId: string,
  queryRunner: Pick<Knex, "raw"> | Knex = db,
): Promise<
  Array<{
    id: string;
    orgId: string;
    amount: string;
    status: string;
    createdAt: string | null;
    startTimestamp: string | null;
    endTimestamp: string | null;
  }>
> => {
  // Prefer query builder when available; fall back to raw for injectable runners.
  if ("select" in queryRunner && typeof queryRunner.select === "function") {
    const rows = await (queryRunner as Knex)("vaults")
      .where({ organization_id: orgId })
      .whereNull("deleted_at")
      .select(
        "id",
        "organization_id",
        "amount",
        "status",
        "created_at",
        "start_date",
        "end_date",
      );

    return rows.map((row) => ({
      id: String(row.id),
      orgId: String(row.organization_id),
      amount: String(row.amount ?? "0"),
      status: String(row.status ?? ""),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      startTimestamp: row.start_date
        ? new Date(row.start_date).toISOString()
        : null,
      endTimestamp: row.end_date ? new Date(row.end_date).toISOString() : null,
    }));
  }

  const raw = await queryRunner.raw(
    `SELECT id, organization_id, amount, status, created_at, start_date, end_date
     FROM vaults
     WHERE organization_id = ?
       AND deleted_at IS NULL`,
    [orgId],
  );

  return unwrapRows<{
    id: string;
    organization_id: string;
    amount: string;
    status: string;
    created_at: string | Date | null;
    start_date: string | Date | null;
    end_date: string | Date | null;
  }>(raw).map((row) => ({
    id: String(row.id),
    orgId: String(row.organization_id),
    amount: String(row.amount ?? "0"),
    status: String(row.status ?? ""),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    startTimestamp: row.start_date
      ? new Date(row.start_date).toISOString()
      : null,
    endTimestamp: row.end_date ? new Date(row.end_date).toISOString() : null,
  }));
};

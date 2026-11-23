import db from "../db/index.js";
import { createSettlementOperation } from "./settlementOperations.js";

const BATCH_SIZE = 50;

let intervalId: ReturnType<typeof setInterval> | null = null;
let cohortIntervalId: ReturnType<typeof setInterval> | null = null;
let lastRefreshSuccess = true;
let lastRefreshError: Error | null = null;

const processExpiredVaultsBatch = async (trx: import("knex").Knex.Transaction): Promise<number> => {
  const expiredVaults = await trx("vaults")
    .select("vaults.id", "vaults.amount", "vaults.failure_destination")
    .where("vaults.status", "active")
    .whereRaw("vaults.end_date <= now()")
    .whereExists(function () {
      this.select(trx.raw("1")).from("milestones")
        .whereRaw("milestones.vault_id = vaults.id")
        .whereRaw("milestones.status::text <> 'approved'")
    })
    .whereNotExists(function () {
      this.select(trx.raw("1")).from("settlement_operations")
        .whereRaw("settlement_operations.vault_id = vaults.id")
        .where("settlement_operations.status", "confirmed")
    })
    .orderBy("vaults.end_date")
    .limit(BATCH_SIZE)
    .forUpdate("vaults")
    .skipLocked();

  let failedCount = 0;
  for (const vault of expiredVaults) {
    const milestone = await trx("milestones")
      .select("id")
      .where("vault_id", vault.id)
      .whereRaw("status::text <> 'approved'")
      .orderBy("deadline")
      .first();
    if (!milestone) continue;

    const updated = await trx("vaults")
      .where({ id: vault.id, status: "active" })
      .update({ status: "failed" });
    if (!updated) continue;

    await createSettlementOperation({
      vaultId: vault.id,
      targetMilestoneId: milestone.id,
      operationKey: `slash_on_miss:${vault.id}`,
      operationType: "redirect",
      requestedBy: "expiration-scheduler",
      destination: vault.failure_destination,
      amount: String(vault.amount),
    }, trx);
    failedCount += 1;
  }
  return failedCount;
};

export const startExpirationChecker = (
  intervalMs = 60_000,
  _jobSystem?: unknown,
): void => {
  if (intervalId) return;
  void _jobSystem;

  const runCheck = async () => runExpirationCheck(intervalMs);

  runCheck();

  intervalId = setInterval(async () => {
    await runCheck();
  }, intervalMs);
  intervalId.unref();
};

export const runExpirationCheck = async (intervalMs = 60_000): Promise<void> => {
  let trx: import("knex").Knex.Transaction;
  try {
    trx = await db.transaction()
  } catch (error) {
    console.error('[ExpirationChecker] Failed to start transaction for heartbeat lock:', error)
    return
  }

  try {
    await trx('scheduler_heartbeats')
      .insert({ name: 'expiration_scheduler', last_run_at: new Date() })
      .onConflict('name')
      .ignore()

    let heartbeat
    try {
      heartbeat = await trx('scheduler_heartbeats')
        .where('name', 'expiration_scheduler')
        .forUpdate()
        .noWait()
        .first()
    } catch {
      console.log('[ExpirationChecker] Overlap detected (lock held), skipping run')
      await trx.rollback()
      return
    }

    if (heartbeat) {
      const gap = Date.now() - new Date(heartbeat.last_run_at).getTime()
      if (gap > intervalMs * 2) {
        console.warn(`[ExpirationChecker] Missed run detected and recovered (gap: ${gap}ms)`)
      }
    }

    const expiredCount = await processExpiredVaultsBatch(trx)
    if (expiredCount > 0) {
      console.log(`[ExpirationChecker] Failed ${expiredCount} expired vault(s) and recorded pending settlements`)
    }

    await trx('scheduler_heartbeats')
      .where('name', 'expiration_scheduler')
      .update({ last_run_at: new Date() })

    await trx.commit()
  } catch (error) {
    console.error('[ExpirationChecker] Check failed:', error)
    await trx.rollback()
  }
};

export const stopExpirationChecker = (): void => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
};

export const startCohortRefreshScheduler = (intervalMs = 3_600_000): void => {
  if (cohortIntervalId) return;

  const runRefresh = async () => {
    const now = new Date();
    try {
      await db.raw(
        "REFRESH MATERIALIZED VIEW CONCURRENTLY vault_cohort_retention",
      );

      await db("scheduler_heartbeats")
        .insert({
          name: "vault_cohort_refresh_job",
          last_run_at: now,
        })
        .onConflict("name")
        .merge({
          last_run_at: now,
        });

      lastRefreshSuccess = true;
      lastRefreshError = null;
    } catch (error: any) {
      lastRefreshSuccess = false;
      lastRefreshError = error;
      console.error(
        "[CohortRefreshScheduler] Failed to refresh materialized view:",
        error,
      );
    }
  };

  runRefresh();

  cohortIntervalId = setInterval(async () => {
    await runRefresh();
  }, intervalMs);
  cohortIntervalId.unref();
};

export const stopCohortRefreshScheduler = (): void => {
  if (cohortIntervalId) {
    clearInterval(cohortIntervalId);
    cohortIntervalId = null;
  }
};

export const checkCohortRefreshJob = (): {
  healthy: boolean;
  error: string | null;
} => {
  return {
    healthy: lastRefreshSuccess,
    error: lastRefreshError ? lastRefreshError.message : null,
  };
};

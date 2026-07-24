import db from "../db/index.js";
import { BackgroundJobSystem } from "../jobs/system.js";
import {
  getIdempotentResponse,
  saveIdempotentResponse,
} from "./idempotency.js";
import { createNotificationService } from "./notifications/factory.js";

const BATCH_SIZE = 50;

let intervalId: ReturnType<typeof setInterval> | null = null;
let cohortIntervalId: ReturnType<typeof setInterval> | null = null;
let lastRefreshSuccess = true;
let lastRefreshError: Error | null = null;

// Module-level default job system instance.
// Tests can inject a different instance via startExpirationChecker's jobSystem param.
let _defaultJobSystem: BackgroundJobSystem | null = null;

const getDefaultJobSystem = (): BackgroundJobSystem => {
  if (!_defaultJobSystem) {
    _defaultJobSystem = new BackgroundJobSystem(
      createNotificationService(process.env.NOTIFICATION_PROVIDER ?? "console"),
    );
  }
  return _defaultJobSystem;
};

const processExpiredVaultsBatch = async (): Promise<string[]> => {
  const failed: string[] = [];

  try {
    const expiredVaults = await db("vaults")
      .where("status", "active")
      .where("end_date", "<=", new Date())
      .limit(BATCH_SIZE);

    if (expiredVaults.length === 0) {
      return failed;
    }

    for (const vault of expiredVaults) {
      try {
        await db("vaults")
          .where("id", vault.id)
          .where("status", "active")
          .update({ status: "failed" });
        failed.push(vault.id);
      } catch (error) {
        console.error(
          `[ExpirationChecker] Failed to mark vault ${vault.id} as failed:`,
          error,
        );
      }
    }

    if (failed.length > 0) {
      console.log(
        `[ExpirationChecker] Failed ${failed.length} expired vault(s): ${failed.join(", ")}`,
      );
    }
  } catch (error) {
    console.error(
      "[ExpirationChecker] Error processing expired vaults:",
      error,
    );
  }

  return failed;
};

const enqueueSlashJobs = async (
  expired: string[],
  jobSystem: BackgroundJobSystem,
): Promise<void> => {
  for (const vaultId of expired) {
    if (process.env.DRY_RUN === "true") {
      console.log(
        `[ExpirationChecker] DRY_RUN: skipping enqueue for vault ${vaultId}`,
      );
      continue;
    }
    const idempotencyKey = `slash_on_miss:${vaultId}`;
    const hash = vaultId;
    const existing = await getIdempotentResponse(idempotencyKey, hash);
    if (existing) continue;
    jobSystem.enqueue(
      "deadline.check",
      {
        vaultId,
        triggerSource: "expiration-scheduler",
      },
      { maxAttempts: 3 },
    );
    await saveIdempotentResponse(idempotencyKey, hash, vaultId, {
      enqueued: true,
    });
  }
};

export const startExpirationChecker = (
  intervalMs = 60_000,
  jobSystem?: BackgroundJobSystem,
): void => {
  if (intervalId) return;

  const resolvedJobSystem = jobSystem ?? getDefaultJobSystem();

  const runCheck = async () => {
    let trx;
    try {
      trx = await db.transaction()
    } catch (e) {
      console.error('[ExpirationChecker] Failed to start transaction for heartbeat lock:', e)
      return
    }

    try {
      // Create the row if it doesn't exist so we can lock it
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
      } catch (e: any) {
        // PostgreSQL throws when lock is not available
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

      const expired = await processExpiredVaultsBatch()
      await enqueueSlashJobs(expired, resolvedJobSystem)

      const now = new Date()
      await trx('scheduler_heartbeats')
        .where('name', 'expiration_scheduler')
        .update({ last_run_at: now })

      await trx.commit()
    } catch (error) {
      console.error('[ExpirationChecker] Check failed:', error)
      await trx.rollback()
    }
  };

  runCheck();

  intervalId = setInterval(async () => {
    await runCheck();
  }, intervalMs);
  intervalId.unref();
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

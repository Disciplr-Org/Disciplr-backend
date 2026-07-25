# Jobs Enqueue Contract

`POST /api/jobs/enqueue` is admin-only and validates payload by job type using a discriminated schema.

## Supported job types

- `notification.send`
- `deadline.check`
- `oracle.call`
- `analytics.recompute`
- `export.generate`
- `sessions.cleanup`

## Enqueue options

- `delayMs`: optional, must be `>= 0`
- `maxAttempts`: optional integer, bounds `1..10`

Options parsing behavior:

- `delayMs` is floored before queue scheduling.
- `maxAttempts` is used as provided after schema validation.

## Retry failed jobs

`POST /api/admin/jobs/:id/retry` is an admin-only endpoint to retry a failed job.

- Resets a job's attempts to 0 and queues it for immediate execution.
- If the job has exhausted its `max_attempts` (i.e. is dead-lettered), the request will be refused unless `?force=true` is passed as a query parameter.
- Emits a `job.retry` audit log upon success.

## Queue depth report

`GET /api/jobs/depth` returns operator-facing queue depth, grouped by job type and state.

- Optional query param `staleLeaseMs` (positive integer) overrides the threshold used to flag
  `stuckActive` jobs; defaults to the `JOB_STALE_LEASE_MS` environment variable (default `300000`,
  i.e. 5 minutes).
- Response shape:

  ```json
  {
    "generatedAt": "2026-06-27T00:00:00.000Z",
    "staleLeaseMs": 300000,
    "totalDepth": 4,
    "byType": {
      "notification.send": { "queued": 0, "delayed": 0, "active": 1, "stuckActive": 1, "deadLetter": 0 }
    }
  }
  ```

- `totalDepth` sums `queued + delayed + active` across all job types (dead-lettered jobs are
  reported separately and excluded from depth).
- `stuckActive` counts active jobs whose lease has exceeded `staleLeaseMs` without completing —
  the candidates a sweep would reclaim.

## Stuck-job sweeper

`POST /api/jobs/sweep` reclaims jobs whose lease has exceeded a stale threshold — for example a
job claimed by a worker that crashed or hung before releasing it.

- Optional query param `staleLeaseMs` (positive integer) overrides the default threshold for this
  sweep run only.
- For each stuck job:
  - If the job has attempts remaining (`attempt < maxAttempts`), it is re-queued for immediate
    execution and counted in `reclaimed`.
  - If the job has exhausted `maxAttempts`, it is moved to the dead-letter queue instead of being
    retried again, and counted in `deadLettered`.
- Jobs whose lease is still within the threshold are left untouched.
- Emits a `job.sweep` audit log with `staleLeaseMs`, `reclaimedCount`, and `deadLetteredCount`.
- Response shape:

  ```json
  {
    "sweptAt": "2026-06-27T00:00:00.000Z",
    "staleLeaseMs": 300000,
    "reclaimed": [{ "jobId": "...", "type": "oracle.call", "attempt": 1, "maxAttempts": 3, "leaseAgeMs": 412000 }],
    "deadLettered": []
  }
  ```

## Error contract

Invalid payloads return:

- HTTP `400`
- `VALIDATION_ERROR` response body from `formatValidationError`
- field-level paths (for example `payload.scope`, `maxAttempts`, `delayMs`)

## Security

- All `/api/jobs/*` endpoints (including `/depth` and `/sweep`) require valid auth token and `ADMIN` role.
- Non-admin users receive `403`.
- On success, enqueue action writes `job.enqueue` audit logs; sweeping writes `job.sweep` audit logs.

---

# Scheduler Overlap Guard

To prevent duplicate execution of scheduled jobs in multi-replica deployments, the job scheduler uses a database-backed advisory lock system.

## Locking Mechanism

Each scheduled job uses a **PostgreSQL advisory lock** to ensure that only one replica can execute the job per interval:

- **Advisory Lock Keys**: Jobs are identified by their name, which is hashed into two 32-bit integers for use with PostgreSQL's `pg_try_advisory_lock(key1, key2)` function.
- **Lock Acquisition**: Before executing a job, the scheduler attempts to acquire the advisory lock. If the lock is already held by another replica, the job is skipped.
- **Lock Release**: Locks are automatically released when:
  - The job completes (successfully or with errors)
  - The database connection that holds the lock is closed (e.g., if the replica crashes)

## Observability

- **Local Overlap Check**: A local Set tracks running jobs to prevent concurrent execution within the same replica.
- **Scheduler Heartbeats**: After a job successfully executes, a heartbeat is written to the `scheduler_heartbeats` table with the job name and last run time.
- **Skipped Jobs**: Logs are generated when a job is skipped (either due to local overlap or failure to acquire the advisory lock).

## Implementation Details

The scheduler registry (`SchedulerRegistry`) is responsible for:
1. Registering scheduled jobs with their intervals and execution functions
2. Managing timers for recurring job execution
3. Handling lock acquisition/release
4. Coordinating with the heartbeat table
5. Preventing local and distributed job overlaps

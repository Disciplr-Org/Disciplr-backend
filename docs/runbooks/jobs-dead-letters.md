# Runbook: Background Job Dead Letters & Queue Backlog

**Severity:** P2 — queue backlog with no failed business operations (dead letters accumulating, export jobs delayed)
**Severity (escalated):** P1 — queue stopped consuming, or dead-letter growth is causing missed deadlines/settlements
**Owner:** On-call backend engineer (escalate to the Platform/Jobs owner per §7)
**Related docs:** [Jobs API contract](../jobs.md) · [Operations Guide](../operations.md) · [Horizon Listener Stall](./horizon-stall.md)

---

## Summary

The background job system exposes its queue through `/api/jobs/*`. This runbook
covers two related failure modes:

1. **Dead letters** — jobs that exhausted `maxAttempts` and were moved to the
   dead-letter queue instead of being retried.
2. **Queue backlog** — `queued` + `delayed` + `active` depth grows faster than
   workers drain it, or `stuckActive` jobs hold leases that will never release.

The generic job queue is **in-memory, per process**. Job state, dead letters and
metrics do not survive a restart and are not shared between replicas. Export jobs
and their dead letters are additionally persisted in `export_jobs` and
`export_dlq_entries`, which are the only job tables you can query directly.

> **Before restarting any replica:** capture the output of §1.4 and §1.5. Dead-letter
> payloads exist only in the process memory of the replica that owns them and are
> lost on restart.

---

## 1. Symptoms & Detection Signals

All `/api/jobs/*` endpoints require `Authorization: Bearer <admin-token>` and the
`ADMIN` role. Non-admin callers receive `403`, unauthenticated callers `401`.

### 1.1 Deep-health endpoint

```bash
curl -s https://api.example.com/api/health/deep \
  -H "Authorization: Bearer <admin-token>" | jq .details.jobs
```

| Field | Backlog / failure signal |
|---|---|
| `status` | `"down"` when the queue is not running (`running: false`) |
| `running` | `false` — workers are not polling; see §2.1 |
| `queueDepth` | Queued (ready) jobs; growth over consecutive polls = backlog |
| `activeJobs` | Jobs currently leased by a worker |
| `totals.enqueued` / `totals.completed` / `totals.failed` | Compare `enqueued` against `completed + failed` to see undrained work |

The top-level deep-health `status` is `"error"` while any component, including
`jobs`, reports `"down"`. Note that deep health does **not** report delayed jobs
or stuck leases — use §1.3 and §1.4 for those.

### 1.2 Queue health endpoint

```bash
curl -s https://api.example.com/api/jobs/health \
  -H "Authorization: Bearer <admin-token>" | jq
```

| Field | Meaning |
|---|---|
| `status` | `"ok"`, `"degraded"` (failure rate > 25 %), `"down"` (workers stopped) |
| `queue.queueDepth` | Ready jobs waiting |
| `queue.delayedJobs` | Jobs scheduled for the future |
| `queue.activeJobs` | Leased jobs |
| `queue.failureRate` | `totals.failed / totals.executions` |

HTTP status is `503` when `status` is `"down"`, otherwise `200` — alerting should
treat `503` as a page and `"degraded"` as a ticket.

### 1.3 Queue metrics

```bash
curl -s https://api.example.com/api/jobs/metrics \
  -H "Authorization: Bearer <admin-token>" \
  | jq '{running, concurrency, queueDepth, delayedJobs, activeJobs, deadLetterJobs, totals, recentFailures}'
```

Key fields:

- `deadLetterJobs` — current dead-letter count.
- `totals.retried` — retries/replays/reclaims since process start.
- `byType.<job-type>` — per-type `queued`, `delayed`, `active`, `completed`,
  `failed`, `deadLetter`; the fastest way to find the offending job type.
- `recentFailures` — last 10 failures with `jobId`, `type`, `failedAt`,
  `attempts`, `error`. Read the `error` string first; it is what the handler threw.

### 1.4 Queue depth report

```bash
# Default stale threshold (JOB_STALE_LEASE_MS, 300000 ms)
curl -s https://api.example.com/api/jobs/depth \
  -H "Authorization: Bearer <admin-token>" | jq

# Override the stale-lease threshold for this report only
curl -s "https://api.example.com/api/jobs/depth?staleLeaseMs=120000" \
  -H "Authorization: Bearer <admin-token>" | jq
```

| Field | Meaning |
|---|---|
| `generatedAt` | Snapshot time — poll twice ≥ 30 s apart to see trends |
| `staleLeaseMs` | Threshold used to classify `stuckActive` |
| `totalDepth` | `queued + delayed + active` across all types (dead letters excluded) |
| `byType.<job-type>.stuckActive` | Active beyond `staleLeaseMs` — sweep candidates (§3.4) |
| `byType.<job-type>.deadLetter` | Dead-lettered count per type |

### 1.5 Dead-letter inspection

```bash
# List every dead letter (payload included)
curl -s https://api.example.com/api/jobs/deadletters \
  -H "Authorization: Bearer <admin-token>" | jq '.deadLetters[] | {jobId, type, attempts, maxAttempts, failedAt, error}'

# Single dead letter by job id
curl -s https://api.example.com/api/jobs/deadletters/<job-id> \
  -H "Authorization: Bearer <admin-token>" | jq
```

A `404` with `{ "error": "Dead-letter job not found" }` means the id is not in
this replica's dead-letter queue (already replayed, or owned by another replica —
see §2.1).

### 1.6 Database evidence

The generic queue has no table; use these to correlate operator actions and
export backlog. Substitute `:job_id`, `:job_type`, `:actor_user_id`.

```sql
-- Operator actions taken on the queue (replay / retry / sweep / enqueue)
SELECT created_at, actor_user_id, action, target_type, target_id, metadata
FROM audit_logs
WHERE action IN ('job.sweep', 'job.deadletter.replay', 'job.retry', 'job.enqueue')
ORDER BY created_at DESC
LIMIT 50;

-- Replay/retry/sweep history for one job id
SELECT created_at, actor_user_id, action, metadata
FROM audit_logs
WHERE target_id = '<job-id>'
ORDER BY created_at DESC;

-- Scheduler liveness: stale heartbeat means scheduled jobs are not running
SELECT name, last_run_at,
       EXTRACT(EPOCH FROM (now() - last_run_at)) AS stale_seconds
FROM scheduler_heartbeats
ORDER BY last_run_at ASC;

-- Persisted export backlog (stuck pending/processing exports)
SELECT status, COUNT(*) AS jobs, MAX(attempts) AS max_attempts
FROM export_jobs
WHERE status IN ('pending', 'processing')
GROUP BY status;

-- Persisted export dead letters
SELECT job_id, job_type, failure_reason, attempt_count, failed_at
FROM export_dlq_entries
ORDER BY failed_at DESC
LIMIT 50;
```

`audit_logs.action` values are written by the jobs router: `job.sweep`,
`job.deadletter.replay`, `job.retry`, `job.enqueue`. For the export tables, check
`docs/jobs.md` for the endpoint contract; the rows above are the persisted
counterpart of the in-memory export queue.

---

## 2. Triage & Diagnosis

Work through these in order; stop at the first confirmed cause.

### 2.1 Is the queue running, and on which replica?

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/api/jobs/health \
  -H "Authorization: Bearer <admin-token>"
```

- `503` / `status: "down"` / `running: false` → workers stopped. Go to §3.1.
- `200` with `queueDepth` flat but high → workers are draining slowly or a
  handler is blocking. Go to §2.3.
- `200` with `queueDepth` rising → enqueue rate exceeds drain rate. Go to §2.4.

Because the queue is per process, the endpoint answers for whichever replica
served the request. Repeat the call a few times (or against each pod) before
concluding that state is lost; `deadletters` and `deadLetterJobs` legitimately
differ between replicas.

### 2.2 Is a scheduler replica holding the distributed lock?

Scheduled jobs use Postgres advisory locks; only one replica runs a given
scheduled job per interval and writes a heartbeat afterwards. A stale heartbeat
means the scheduled producer (e.g. `deadline.check`) is not enqueuing:

```sql
SELECT name, last_run_at,
       EXTRACT(EPOCH FROM (now() - last_run_at)) AS stale_seconds
FROM scheduler_heartbeats
WHERE name = '<scheduler-name>';
```

If `stale_seconds` keeps growing, go to §2.5 (stuck replicas) — do not start a
second copy of the scheduler by hand.

### 2.3 Which job types are failing, and why?

```bash
curl -s https://api.example.com/api/jobs/metrics \
  -H "Authorization: Bearer <admin-token>" \
  | jq '[.byType | to_entries[] | select(.value.failed > 0 or .value.deadLetter > 0)
         | {type: .key, failed: .value.failed, deadLetter: .value.deadLetter}]'
```

Then read `recentFailures[].error` and the service logs for the same time window.
Typical buckets:

- **Downstream outage** (Horizon/Soroban, mail provider, S3): retries exhaust
  because the dependency is down. Fix the dependency first; replay afterwards.
- **Poison payload** (validation error, missing referenced row): every retry
  fails identically. Inspect the payload with §1.5 and fix the handler or the
  enqueueing caller before replaying.
- **Handler regression** introduced by a deploy: correlate `failedAt` with the
  deploy time and prefer rollback of the deploy (§5) over replay storms.

### 2.4 Is the backlog caused by in-flight work or stuck leases?

Poll §1.4 twice, at least 30 s apart:

- `stuckActive` > 0 and growing → workers crashed/hung mid-job. Go to §3.4.
- `active` stable while `queued` grows → handlers are slow, not stuck. Consider
  raising `JOB_WORKER_CONCURRENCY` on the deployment (§8) and verify the
  dependency latency before doing so.
- `delayed` dominates `totalDepth` → this is scheduled work, not a backlog;
  confirm the run times are expected.

### 2.5 Is the database healthy?

The queue itself is in-memory, but `job.sweep`, `job.deadletter.replay`,
`job.retry` and `job.enqueue` write audit logs, and the scheduler writes
heartbeats. A failing database turns every operator action into a `500`:

```bash
curl -s https://api.example.com/api/health/deep \
  -H "Authorization: Bearer <admin-token>" | jq '.details.database'
```

Fix database connectivity before attempting remediation. See
[operations.md](../operations.md).

---

## 3. Remediation

### 3.1 Restart a replica whose workers have stopped

```bash
# systemd
systemctl restart disciplr-backend

# Kubernetes
kubectl rollout restart deployment/disciplr-backend
```

> **Data loss warning:** a restart discards that replica's in-memory queue,
> dead letters and metrics. Export any dead-letter payload you still need
> (§1.5) before restarting, and re-enqueue any critical pending work (§3.5).

### 3.2 Replay a dead-letter job

Replay removes the entry from the dead-letter queue and enqueues a **new job
with a new id**, using the original payload and `maxAttempts`:

```bash
curl -s -X POST https://api.example.com/api/jobs/deadletters/<job-id>/replay \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" -d '{}' | jq
```

Success: `202 Accepted`

```json
{ "replayed": true, "job": { "id": "<new-job-id>", "type": "export.generate", "runAt": "2026-11-22T00:00:00.000Z", "maxAttempts": 3 } }
```

A `404` means the id is not a dead letter on this replica. Replay refuses with
`404` and an explanatory `error` when the job is currently active or already
pending — resolve that race (§5) before retrying the replay.

An `audit_logs` row with action `job.deadletter.replay` is written, including
`replayedJobId`, `jobType` and `maxAttempts`.

### 3.3 Retry a dead-lettered job in place

`POST /api/jobs/:id/retry` retries a dead-lettered job only with
`?force=true` (otherwise it is refused because `maxAttempts` is exhausted):

```bash
curl -s -X POST "https://api.example.com/api/jobs/<job-id>/retry?force=true" \
  -H "Authorization: Bearer <admin-token>" | jq
```

Success: `202 Accepted` with `{ "retried": true, "job": { ... } }`. Missing jobs
return `404`; other refusals (already active, already pending, not yet attempted)
return `400` with the reason in `error`. Audit action: `job.retry`.

### 3.4 Sweep stuck leases

Reclaim jobs whose lease exceeded the stale threshold. Jobs with attempts left
are re-queued and counted in `reclaimed`; jobs that exhausted `maxAttempts` are
moved to the dead-letter queue and counted in `deadLettered`:

```bash
# Use the default JOB_STALE_LEASE_MS
curl -s -X POST https://api.example.com/api/jobs/sweep \
  -H "Authorization: Bearer <admin-token>" | jq

# Explicit threshold (milliseconds, positive integer) for this run
curl -s -X POST "https://api.example.com/api/jobs/sweep?staleLeaseMs=120000" \
  -H "Authorization: Bearer <admin-token>" | jq
```

Response: `200 OK`

```json
{
  "sweptAt": "2026-11-22T00:00:00.000Z",
  "staleLeaseMs": 300000,
  "reclaimed": [{ "jobId": "<job-id>", "type": "oracle.call", "attempt": 1, "maxAttempts": 3, "leaseAgeMs": 412000 }],
  "deadLettered": []
}
```

Choose `staleLeaseMs` above the slowest legitimate handler duration, otherwise
you will duplicate work that is still running. Audit action: `job.sweep`.
Invalid `staleLeaseMs` returns `400` with `{ "error": "staleLeaseMs must be a positive integer" }`.

### 3.5 Re-enqueue critical work manually

```bash
curl -s -X POST https://api.example.com/api/jobs/enqueue \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "deadline.check",
    "payload": { "vaultId": "<vault-uuid>", "triggerSource": "manual" },
    "maxAttempts": 3,
    "delayMs": 0
  }' | jq
```

Success: `202 Accepted` with `{ "queued": true, "job": { ... } }`. Payloads are
validated per type — an invalid payload returns `400` with a `VALIDATION_ERROR`
body. `maxAttempts` must be an integer in `1..10`; `delayMs` must be `0..60000`.
Audit action: `job.enqueue`. The supported types are listed in
[jobs.md](../jobs.md).

### 3.6 Drain persisted export backlog

Export jobs have their own persisted queue. Inspect §1.6 first; if
`export_jobs` has many `pending` rows and no `processing` rows, workers are not
picking them up — follow §3.1. Re-enqueuing by hand is not safe for exports
(the result payload and idempotency key are stored per row); replay from
`export_dlq_entries` through the export endpoints instead of inserting rows.

---

## 4. Verification Checklist

Run all checks before closing the incident.

- [ ] `GET /api/jobs/health` returns `200` with `status: "ok"` (or a known
      `"degraded"` caused by historical failures that are no longer occurring)
- [ ] `GET /api/health/deep` → `details.jobs.status = "up"` and
      `details.jobs.running = true`
- [ ] `GET /api/jobs/depth` → `totalDepth` decreasing across two polls ≥ 30 s apart
- [ ] `GET /api/jobs/depth` → `byType.<job-type>.stuckActive` is `0`
- [ ] `GET /api/jobs/metrics` → `totals.completed` increasing and
      `totals.failed` no longer climbing
- [ ] `GET /api/jobs/metrics` → `deadLetterJobs` matches the intended final
      count (dead letters you deliberately left in place, if any)
- [ ] Every replayed/retried job id appears in `audit_logs`:

```sql
SELECT created_at, action, target_id, metadata
FROM audit_logs
WHERE action IN ('job.deadletter.replay', 'job.retry', 'job.sweep')
ORDER BY created_at DESC
LIMIT 20;
```

- [ ] `export_jobs` has no unbounded `pending` backlog (§1.6 queries)

---

## 5. Rollback / Abort Path

- **Replay created an unwanted job:** replay and retry produce a *new* job id and
  there is no HTTP endpoint to delete a queued job. Stop the replica gracefully
  (the job system waits up to 2 s for active jobs), correct the payload/caller,
  and re-enqueue the intended work. Audit rows for the original replay remain —
  never delete audit history.
- **Sweep duplicated work:** a `reclaimed` job is re-queued, not copied. If the
  original worker was actually still alive, both the reclaim and the late
  completion may run. Verify idempotency of the handler; if it is not
  idempotent, pause the affected producer and reconcile side effects before
  resuming.
- **A deploy caused the failure:** roll back the deploy rather than replaying
  into a broken handler. Replays survive the rollback only if the replica is not
  restarted (in-memory queue), so fix forward first.
- **Replay/retry returns a race error** (`currently active` / `already pending`):
  wait for the active attempt to finish, then re-check §1.4 before retrying.

---

## 6. Escalation

1. **On-call engineer** — owns §1–§3 and must capture §1.3–§1.5 output before any
   restart.
2. **Jobs/Platform owner** — page when: the queue is `down` and a restart did not
   recover it, dead letters grow after a replay, or the failing type drives
   financial state (`settlement.process`, `deadline.check`, `oracle.call`).
3. **Database owner** — page when §2.5 shows the database down, or
   `export_jobs`/`export_dlq_entries` writes fail.
4. **Security** — page only if queue/audit writes fail in a way that bypasses
   authorization or audit logging.

Include in the escalation: timestamps, affected replica/pod, `/api/jobs/metrics`
output, `/api/jobs/depth` output, the dead-letter `error` strings, and the audit
trail rows already written.

---

## 7. Post-incident Checklist

- [ ] Root cause recorded (dependency outage, poison payload, stuck replica,
      deploy regression, or capacity) with the failing job type
- [ ] Dead-letter payloads captured in the incident ticket before they were lost
- [ ] Replayed/retried jobs verified as completed (§4)
- [ ] Handler fixed and covered by a regression test where the cause was code
- [ ] Idempotency confirmed for every handler that was swept or replayed
- [ ] Capacity reviewed (`JOB_WORKER_CONCURRENCY`, replica count, dependency
      latency) if the cause was backlog from throughput
- [ ] Alert thresholds reviewed — should `deadLetterJobs` / `queueDepth` page
      sooner?
- [ ] This runbook updated if any command or field differed from reality

---

## 8. Environment Variables Reference

| Variable | Default | Effect on backlog / dead letters |
|---|---|---|
| `JOB_WORKER_CONCURRENCY` | `2` | Parallel jobs per replica; raising drains faster but increases dependency load |
| `JOB_QUEUE_POLL_INTERVAL_MS` | `250` | How often workers poll for ready jobs |
| `JOB_STALE_LEASE_MS` | `300000` | Default stale threshold for `/depth` and `/sweep`; must exceed the slowest legitimate handler |
| `JOB_HISTORY_LIMIT` | `50` | Completed/failed history retained for metrics (`recentFailures` keeps the last 10) |
| `ENABLE_JOB_SCHEDULER` | enabled | Set to `false` to stop recurring schedulers (e.g. while draining a poisoned queue) |

All values are read from the process environment at startup; changing them
requires a deployment restart (see the data-loss warning in §3.1).

---

## 9. Admin Endpoints Quick Reference

| Endpoint | Purpose |
|---|---|
| `GET /api/health/deep` | System health including `details.jobs` |
| `GET /api/jobs/health` | Queue liveness and failure rate (`503` when down) |
| `GET /api/jobs/metrics` | Totals, per-type counters, recent failures |
| `GET /api/jobs/depth` | Queue depth by type/state with `stuckActive` |
| `GET /api/jobs/deadletters` | List dead letters with payloads |
| `GET /api/jobs/deadletters/:id` | Inspect one dead letter |
| `POST /api/jobs/deadletters/:id/replay` | Replay a dead letter as a new job |
| `POST /api/jobs/:id/retry` | Retry a job (dead letters need `?force=true`) |
| `POST /api/jobs/sweep` | Reclaim jobs with stale leases |
| `POST /api/jobs/enqueue` | Manually enqueue a typed job |

All `/api/jobs/*` endpoints require `Authorization: Bearer <admin-token>` with
the `ADMIN` role. The same routes are also mounted under `/api/v1/jobs/*`.

---

## 10. DB Tables Reference

| Table | Relevance |
|---|---|
| `audit_logs` | Operator actions: `job.sweep`, `job.deadletter.replay`, `job.retry`, `job.enqueue` |
| `scheduler_heartbeats` | Per-scheduler `last_run_at`; stale rows mean scheduled jobs are not enqueuing |
| `export_jobs` | Persisted export jobs (`status`, `attempts`, `max_attempts`, `error`) |
| `export_dlq_entries` | Persisted export dead letters (`job_id`, `failure_reason`, `error_message`, `attempt_count`, `failed_at`) |

The generic job queue (dead letters, depth, metrics) is in-memory per replica and
has no table — always inspect it through the `/api/jobs/*` endpoints.

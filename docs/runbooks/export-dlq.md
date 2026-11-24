# Runbook: Export Dead-Letter Queue

**Severity:** P2 — export jobs have exhausted retries and users cannot retrieve their exports
**Owner:** On-call backend engineer
**Related docs:** [Export API and DLQ](../export.md) · [Background job dead letters](./jobs-dead-letters.md) · [Operations Guide](../operations.md)

---

## Symptoms

- Users report exports stuck in `failed` status or repeated export failures.
- `export_dlq_entries` contains rows, or its count is growing.
- Logs contain `exports.job_failed`; permanent failures are persisted with a
  `failure_reason` of `serialization_error`, `data_fetch_error`, or `unknown_error`.

The export DLQ is persisted in Postgres. It is separate from the generic
per-process `/api/jobs/deadletters` queue; that endpoint does **not** inspect or
replay `export_dlq_entries`.

## Diagnosis

Use the production API base URL and a valid token. Admin tokens can inspect any
export status; a non-admin token can inspect only its own export.

### Check system and job status

```bash
curl -sS --fail-with-body "$API_BASE/api/health/deep" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.details.jobs'

curl -sS --fail-with-body "$API_BASE/api/exports/status/$JOB_ID" \
  -H "Authorization: Bearer $EXPORT_OWNER_OR_ADMIN_TOKEN" | jq
```

`$API_BASE` is the origin (for example `https://api.example.com`), without a
trailing slash. The status response includes `status`, `attempts`, `maxAttempts`,
and, for failed jobs, the sanitized `error`.

### Inspect persisted entries

Run these queries against the production Postgres database using a read-only
account where possible:

```sql
-- DLQ depth and age, grouped by the service's failure classifications
SELECT failure_reason, COUNT(*) AS entries, MIN(failed_at) AS oldest,
       MAX(failed_at) AS newest
FROM export_dlq_entries
GROUP BY failure_reason
ORDER BY entries DESC;

-- Recent entries and associated export state
SELECT d.job_id, d.job_type, d.failure_reason, d.error_message,
       d.attempt_count, d.failed_at, d.sanitised_context,
       j.status, j.attempts, j.max_attempts, j.scope, j.format
FROM export_dlq_entries AS d
LEFT JOIN export_jobs AS j ON j.id = d.job_id
ORDER BY d.failed_at DESC
LIMIT 50;
```

Capture the target row and its corresponding `export_jobs` values before
re-driving. A missing `export_jobs` row is an orphan: do not requeue it.
`sanitised_context` is privacy-filtered; do not try to recover user IDs from it.

### Classify the failure

- `data_fetch_error`: check Postgres connectivity and the relevant data query.
- `serialization_error`: check export scope/format/data shape and recent
  serializer changes.
- `unknown_error`: correlate the job's `failed_at` with application logs,
  deployment events, and S3/configuration health.

Fix the underlying cause before re-driving. If no corresponding failure is
visible, inspect application logs around `failed_at` for `exports.job_failed`.

## Remediation

There is currently **no HTTP endpoint** for listing or replaying the persisted
export DLQ. The service exports `getDlqEntries`, `getDlqEntry`,
`getDlqDepth`, and `requeueDlqEntry`; the app configures these against
`export_dlq_entries`. Requeue one reviewed job at a time using the existing
service method:

```bash
# Requires the repository's installed dependencies and DATABASE_URL.
# Requeue resets attempts and removes the persisted DLQ row. It does not
# directly enqueue work; startup recovery handles the now-pending export.
JOB_ID='<job-uuid>' node --import tsx --input-type=module <<'NODE'
import db from './src/db/index.ts'
import {
  configureExportJobRepository,
  configureDlqRepository,
  createKnexExportJobRepository,
  createKnexDlqRepository,
  getJob,
  getDlqEntry,
  requeueDlqEntry,
} from './src/services/exportQueue.ts'

try {
  configureExportJobRepository(createKnexExportJobRepository(db))
  configureDlqRepository(createKnexDlqRepository(db))
  const jobId = process.env.JOB_ID
  if (!jobId) throw new Error('Set JOB_ID to the export job UUID')
  if (!(await getDlqEntry(jobId))) throw new Error(`No DLQ entry for ${jobId}`)
  if (!(await getJob(jobId))) throw new Error(`No export job for ${jobId}; refusing orphan`)
  if (!(await requeueDlqEntry(jobId))) throw new Error(`Could not requeue ${jobId}`)
  console.log(`Requeued export ${jobId}; restart one worker instance to recover it`)
} finally {
  await db.destroy()
}
NODE
```

The command only updates persisted state. `BackgroundJobSystem.start()` calls
`recoverPendingExportJobs`, which queues pending exports whose attempts are below
`max_attempts`. Coordinate a restart of **one** worker instance to trigger that
recovery; avoid simultaneously restarting multiple replicas, since each
instance has its own in-memory queue and performs startup recovery.

Verify the job becomes `pending` and then advances to `running` or `done`:

```bash
curl -sS --fail-with-body "$API_BASE/api/exports/status/$JOB_ID" \
  -H "Authorization: Bearer $EXPORT_OWNER_OR_ADMIN_TOKEN" | jq
```

## Rollback

Requeue is not automatically reversible: it removes the DLQ row and resets the
job's attempt count. If the worker has **not** started processing, stop that
worker and restore the saved `export_jobs` values and captured DLQ row in a
single transaction. Use the exact values captured during diagnosis; do not
reconstruct or replace the sanitized context:

```sql
BEGIN;

UPDATE export_jobs
SET status = 'failed',
    attempts = <PREVIOUS_ATTEMPTS>,
    completed_at = <PREVIOUS_COMPLETED_AT>,
    error = '<PREVIOUS_ERROR>'
WHERE id = '<JOB_ID>';

INSERT INTO export_dlq_entries
  (job_id, job_type, failure_reason, error_message, attempt_count, failed_at, sanitised_context)
VALUES
  ('<JOB_ID>', '<JOB_TYPE>', '<FAILURE_REASON>', '<DLQ_ERROR>',
   <DLQ_ATTEMPT_COUNT>, '<FAILED_AT>', '<SANITISED_CONTEXT_JSON>'::jsonb)
ON CONFLICT (job_id) DO NOTHING;

COMMIT;
```

If processing has started, do not restore stale state or delete a completed
result. Stop further retries, preserve current DB/log evidence, and escalate.

## Escalation

Escalate to the export-service owner and Platform/Database on-call when the
failure persists after the suspected dependency or code regression is fixed,
the DLQ continues growing, a requeued job fails again, or an orphaned entry is
found. Include job ID, failure reason, attempt count, timestamps, sanitized
error/context, relevant logs, and the result of the export status endpoint.
Never include bearer tokens or raw user identifiers in the incident record.

## Post-incident Checklist

- [ ] Confirm the underlying failure is fixed before replaying remaining jobs.
- [ ] Confirm requeued exports progress using `/api/exports/status/:jobId`.
- [ ] Confirm `export_dlq_entries` depth is stable or decreasing.
- [ ] Check logs for new `exports.job_failed` events.
- [ ] Record affected job IDs, actions, and outcome; file a follow-up for recurring failures.
- [ ] Review whether alerting, retry policy, or export tests need improvement.

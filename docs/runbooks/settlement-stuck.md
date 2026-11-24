# Runbook: Stuck Settlement Operations

**Severity:** P1 — settlement operations stalled or financial status is uncertain
**Owner:** On-call backend engineer
**Related docs:** [Settlement Operations](../settlement-operations.md) · [Jobs API](../jobs.md) · [Jobs Dead Letters Runbook](./jobs-dead-letters.md) · [Operations Guide](../operations.md)

## Symptoms

- Rows in `settlement_operations` remain `pending` or `submitted` across several
  `SETTLEMENT_PROCESS_INTERVAL_MS` intervals (default 30 seconds).
- `settlement.process` jobs fail, accumulate in the job dead-letter queue, or
  stop running.
- Logs contain `settlement_operation_dead_lettered`, or a settlement's
  `failure_code` / `failure_message` indicates an RPC, network, or contract
  failure.
- A user reports an incomplete release or redirect, or the database state and
  chain outcome appear inconsistent.

The worker selects only `pending` and `submitted` operations. It retries
submission failures up to five times; terminal failures are recorded as
`failed`. A `failed` operation is **not** retried by `settlement.process` or by
replaying that job.

## Diagnosis

All `/api/jobs/*` commands below require an admin bearer token and operate on
the replica that serves the request. Set `API_URL` to the production API base
and `ADMIN_TOKEN` to a short-lived admin token.

### 1. Check job queue health

```bash
export API_URL="https://api.example.com"
export ADMIN_TOKEN="<admin-token>"

curl -sS "$API_URL/api/health/deep" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.details.jobs'

curl -sS "$API_URL/api/jobs/health" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

curl -sS "$API_URL/api/jobs/metrics" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.byType["settlement.process"], .recentFailures'
```

Compare repeated metrics polls at least 30 seconds apart. Check that the queue
is running and that `settlement.process` executions are progressing. The
`settlement.process` scheduler runs immediately after startup, then every 30
seconds by default; `SETTLEMENT_PROCESS_INTERVAL_MS` changes the interval.

### 2. Inspect settlement rows (read-only)

Run against the production PostgreSQL database using the approved operator
access path. Do not update these rows manually.

```sql
-- Recent in-flight and failed operations; replace the value to focus on one row.
SELECT id, milestone_id, vault_id, target_milestone_id, operation_type, status,
       attempt_count, transaction_hash, failure_code, failure_message,
       created_at, updated_at, submitted_at, confirmed_at
FROM settlement_operations
WHERE status IN ('pending', 'submitted', 'failed')
  AND (id = '<operation-id>' OR '<operation-id>' = '')
ORDER BY updated_at ASC
LIMIT 100;

-- Age and counts by status; submitted rows should not remain unconfirmed.
SELECT status, COUNT(*) AS operations,
       MIN(updated_at) AS oldest_updated_at,
       EXTRACT(EPOCH FROM (now() - MIN(updated_at))) AS oldest_age_seconds
FROM settlement_operations
WHERE status IN ('pending', 'submitted', 'failed')
GROUP BY status
ORDER BY status;
```

### 3. Check failed jobs and audit history

```bash
curl -sS "$API_URL/api/jobs/deadletters" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.deadLetters[] | select(.type == "settlement.process")'
```

The generic job queue and its dead letters are in memory per replica; they are
not stored in a jobs table and are lost on process restart. Capture this output
before restarting a replica.

```sql
-- Recent queue actions and any manually enqueued settlement job.
SELECT created_at, actor_user_id, action, target_id, metadata
FROM audit_logs
WHERE action IN ('job.enqueue', 'job.deadletter.replay', 'job.retry')
ORDER BY created_at DESC
LIMIT 50;
```

Review service logs for `settlement_operation_dead_lettered` and
`[jobs:settlement.process]` messages. A job-level dead letter is distinct from
an operation row with `status = 'failed'`; the latter is persisted in
`settlement_operations`.

## Remediation

1. **Fix the underlying blocker first.** Check Soroban/RPC availability,
   database connectivity, deployment health, and configuration. Confirm
   `DRY_RUN` is not set to `true`; in that mode the handler intentionally skips
   settlement processing.
2. **Allow the scheduled worker to recover normal in-flight rows.** It
   automatically selects and processes up to 20 oldest `pending`/`submitted`
   rows per run. A `submitted` row is confirmed using its recorded transaction
   hash; do not create or submit a replacement transaction based only on its
   age.
3. **If the queue is healthy but the scheduler needs a one-time nudge, enqueue
   one bounded batch** (maximum `batchSize` is 100). This runs the regular
   handler; it does not target a particular operation:

   ```bash
   curl -sS -X POST "$API_URL/api/jobs/enqueue" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"type":"settlement.process","payload":{"batchSize":20}}' | jq
   ```

   Do not repeatedly enqueue batches while the scheduled worker is active.
   The handler uses row locks to avoid concurrent workers claiming the same
   operation.
4. **If a `settlement.process` job is in the dead-letter queue**, fix the
   handler-level cause, capture the dead-letter details, then replay that job
   once:

   ```bash
   curl -sS -X POST \
     "$API_URL/api/jobs/deadletters/<job-id>/replay" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" -d '{}' | jq
   ```

   This replays the batch job, not a particular settlement operation.
5. **For an operation in `failed` state, stop and escalate.** Neither the
   scheduled worker nor replaying/enqueuing `settlement.process` retries failed
   rows. There is no operator endpoint to retry an individual settlement.
   Preserve the operation identity and transaction history; do not change its
   status, delete it, or create a replacement operation key manually.

## Rollback

- Enqueueing or replaying a queue job cannot be undone through an API endpoint.
  Do not repeat the action; observe the single job and reconcile its outcome.
- Do not run ad hoc `UPDATE`/`DELETE` statements against `settlement_operations`.
  The service enforces operation identity and transaction-hash consistency;
  bypassing it can cause duplicate or misdirected settlements.
- If a submitted or confirmed operation may have an incorrect chain outcome,
  stop further manual actions and escalate with the operation ID, transaction
  hash, timestamps, and relevant logs. Do not attempt a compensating settlement
  until the chain state and intended business action are verified.

## Escalation

Page the settlement/service owner and the on-call platform or database owner
when:

- queue health remains down after the standard service recovery procedure;
- `pending`/`submitted` rows continue aging after queue processing resumes;
- an operation is `failed`, or its transaction hash conflicts with observed
  chain state;
- there is any uncertainty about whether value was transferred or about the
  correct beneficiary.

Include affected operation IDs, status/count query results, the relevant job
metrics and dead-letter output, log timestamps, deployment/replica, and
transaction hashes. Redact credentials, signing material, and unrelated user
data.

## Post-incident Checklist

- [ ] Confirm the root cause and resolution are recorded in the incident.
- [ ] Verify `settlement.process` runs and queue health is stable.
- [ ] Confirm affected operation rows have an expected final state; investigate
      every remaining `pending`, `submitted`, or `failed` row.
- [ ] Verify transaction hashes and business outcomes with the approved chain
      reconciliation process before reporting settlements complete.
- [ ] Record any manual enqueue/replay action and confirm its audit row in
      `audit_logs`.
- [ ] Add regression coverage or monitoring for the identified failure mode.
- [ ] Update this runbook if any diagnostic or recovery step differed from the
      deployed behavior.

## Endpoint Reference

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health/deep` | Deep health, including job system status |
| `GET` | `/api/jobs/health` | Queue liveness and failure rate |
| `GET` | `/api/jobs/metrics` | Per-type execution metrics and recent failures |
| `GET` | `/api/jobs/deadletters` | Inspect in-memory dead-letter jobs |
| `POST` | `/api/jobs/deadletters/:id/replay` | Replay one dead-lettered job |
| `POST` | `/api/jobs/enqueue` | Enqueue a validated job, including `settlement.process` |

All `/api/jobs/*` endpoints require an authenticated admin user with the
`ADMIN` role.

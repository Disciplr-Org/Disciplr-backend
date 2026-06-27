# On-Call SLO and Alerting Runbook

This runbook defines the first-response path for Disciplr production alerts tied to background jobs, the database pool, and the Horizon listener. It uses the Prometheus gauges exposed from `src/routes/metrics.ts` plus the admin health endpoints referenced below.

## Metrics Source

Scrape the authenticated metrics router that is mounted in `src/app.ts`. In the current Express wiring, `metricsRouter` exposes `GET /metrics` under the `/api/metrics` mount, so the full route is `GET /api/metrics/metrics`.

The custom metrics used by this runbook are:

| Metric | Type | Meaning |
|--------|------|---------|
| `disciplr_job_queue_depth` | Gauge | Current depth of the background job queue |
| `disciplr_job_failed_total` | Gauge | Total failed jobs reported by the job system |
| `disciplr_db_available_connections` | Gauge | Available connections in the DB pool |
| `disciplr_db_waiting_clients` | Gauge | Clients waiting for a DB connection |
| `disciplr_horizon_listener_lag` | Gauge | Ledger lag between Horizon and the listener |

## SLOs and Alert Thresholds

| Signal | SLO | Warning alert | Critical alert | First response |
|--------|-----|---------------|----------------|----------------|
| Queue depth | 99% of 5-minute windows stay below 50 queued jobs | `disciplr_job_queue_depth > 50` for 10 minutes | `disciplr_job_queue_depth > 200` for 5 minutes | Check `GET /api/jobs/health` and `GET /api/jobs/metrics`; pause noncritical producers; inspect worker logs; raise worker concurrency only after confirming the DB pool is healthy |
| Job failures | No sustained growth in failed jobs during normal traffic | `increase(disciplr_job_failed_total[15m]) > 5` | `increase(disciplr_job_failed_total[15m]) > 25` or dead-letter growth | Inspect recent failed payloads, retry known transient failures with `POST /api/admin/jobs/:id/retry`, and stop replaying jobs if failures are deterministic |
| DB available connections | At least one pool connection remains available in normal traffic | `disciplr_db_available_connections == 0` for 5 minutes | Available connections are `0` while waiting clients are present | Open `GET /api/admin/db/metrics`; identify slow query patterns; rollback a noisy deploy; reduce worker concurrency; scale the pool or database if saturation is real |
| DB waiting clients | Waiting clients remain at `0` in steady state | `disciplr_db_waiting_clients > 0` for 5 minutes | `disciplr_db_waiting_clients > 5` for 5 minutes | Treat as active database contention; correlate with slow queries and queue depth before adding more workers |
| Horizon listener lag | 99% of 5-minute windows stay at or below `HORIZON_LAG_THRESHOLD` (default `10`) | `disciplr_horizon_listener_lag > HORIZON_LAG_THRESHOLD` for 10 minutes | `disciplr_horizon_listener_lag > 100` for 5 minutes or the metric is absent for 15 minutes | Verify Horizon availability and configured contract IDs; inspect listener logs; restart the listener if it is stalled; check whether `START_LEDGER` or backfill activity explains the lag |

## Prometheus Rules

Use these expressions as a starting point and tune durations for the paging policy in each environment.

```promql
disciplr_job_queue_depth > 50
increase(disciplr_job_failed_total[15m]) > 5
disciplr_db_available_connections == 0
disciplr_db_waiting_clients > 0
disciplr_horizon_listener_lag > 10
absent(disciplr_horizon_listener_lag)
```

For critical DB contention, alert on the combined signal so a single exhausted pool sample does not page by itself:

```promql
disciplr_db_available_connections == 0 and disciplr_db_waiting_clients > 0
```

## Triage Flow

1. Confirm the alert is still firing and note the first firing timestamp.
2. Check whether the alert coincides with a deploy, migration, backfill, or planned maintenance window.
3. Compare queue depth, job failures, DB waiting clients, and listener lag before taking action. These signals often cascade.
4. Prefer reducing load first when the database is saturated. Increasing job concurrency while `disciplr_db_waiting_clients` is above `0` can amplify the incident.
5. Record every mitigation in the incident notes with timestamp, command or endpoint used, owner, and observed result.

## Escalation

Escalate to the primary on-call owner when a warning alert is still firing after the documented response. Escalate to the database owner when DB pool critical alerts last more than 15 minutes, slow query volume grows, or data durability is in doubt. Escalate to the chain or infrastructure owner when listener lag remains critical for more than 15 minutes, Horizon is degraded, or contract configuration looks wrong.

Open a coordinated incident when queue depth, job failures, and DB contention are all firing at the same time, or when user-facing transaction processing is delayed.

## Silencing Policy

Only silence alerts during approved maintenance, controlled deploys, expected backfills, or while a documented incident mitigation is already underway.

Every silence must include an owner, reason, expected end time, and a linked issue or incident. Warning silences should be limited to 2 hours. Critical silences should be limited to 30 minutes unless the incident commander approves a longer window.

Do not silence alerts when user-facing errors are increasing, data loss is suspected, or the alert has not been triaged.

## Related Docs

- [Database Metrics & Operations](../operations-metrics.md)
- [Jobs Enqueue Contract](../jobs.md)
- [Horizon Listener](../horizon-listener.md)
- [Horizon Events](../horizon-events.md)
- [Database Migrations](../database-migrations.md)

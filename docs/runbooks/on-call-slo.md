# On-Call SLO and Alerting Runbook

## Purpose

This document defines Service Level Objectives (SLOs) for critical Disciplr infrastructure metrics, provides Prometheus alert rules, and guides on-call engineers through remediation and escalation procedures during incidents. Use this runbook when alerts fire at any time of day, and as a reference for understanding expected system behavior and acceptable thresholds.

**Target Audience:** On-call engineers, service owners, incident commanders  
**When to Use:** During alert pages (especially 3am), to understand SLO targets, remediation steps, and escalation policies  
**Last Updated:** June 27, 2026

---

## Gauge Reference

This table lists all monitored Prometheus gauges relevant to SLO tracking. All gauge names and help strings are sourced directly from `src/routes/metrics.ts`.

| Gauge Name | Description | Type | Labels |
|-----------|-------------|------|--------|
| `disciplr_job_queue_depth` | Current depth of the background job queue | Gauge | None (aggregate only) |
| `disciplr_db_available_connections` | Number of available DB connections in the pool | Gauge | None (aggregate only) |
| `disciplr_db_waiting_clients` | Number of clients waiting for a DB connection | Gauge | None (aggregate only) |
| `disciplr_horizon_listener_lag` | Lag (in ledgers) between Horizon and our listener | Gauge | None (aggregate only) |
| `disciplr_outbox_relay_lag_seconds` | Outbox relay lag in seconds (oldest unprocessed row age) | Gauge | None (aggregate only) |
| `disciplr_job_failed_total` | Total number of failed jobs | Gauge | None (aggregate only) |

**Note:** All gauges are aggregate-only (no tenant/org/user labels) to prevent leaking tenant identity through metrics.

---

## SLO 1: Job Queue Depth

### What it Measures

The background job queue (`disciplr_job_queue_depth`) tracks how many jobs are pending execution in the asynchronous job system. A queue that grows unboundedly indicates:
- Workers are overwhelmed by request volume
- Worker processes have crashed or become unresponsive
- Job processing is blocked by a downstream dependency (database, external API)

High queue depth delays job execution, affecting async workflows like event processing, notifications, and batch operations.

### SLO Target

- **Warning threshold:** Queue depth > 100 for > 5 minutes
- **Critical threshold:** Queue depth > 500 for > 2 minutes
- **SLO:** Queue depth < 100 for 99% of the time over a 7-day rolling window
- **Target availability:** 99% (1% failure budget over 7 days ≈ 10 minutes of permitted exceedance)

### Prometheus Alert Rules

```yaml
- alert: JobQueueDepthWarning
  expr: disciplr_job_queue_depth > 100
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Job queue depth elevated"
    description: "Job queue depth is {{ $value }} (warning threshold: 100). Investigate if workers are lagging or crashed."

- alert: JobQueueDepthCritical
  expr: disciplr_job_queue_depth > 500
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Job queue depth critical"
    description: "Job queue depth is {{ $value }} (critical threshold: 500). Immediate intervention required."
```

### Remediation Steps

1. **Acknowledge and triage** (< 2 minutes)
   - Check current queue depth: `curl /api/metrics | grep disciplr_job_queue_depth`
   - Record the value and timestamp for escalation

2. **Inspect worker health** (2-5 minutes)
   - Check if worker processes are running: `ps aux | grep worker`
   - If workers are down, restart: `docker restart disciplr-workers` or equivalent
   - Check worker logs for crash messages or exceptions

3. **Check downstream dependencies**
   - **Database:** Is DB connection pool exhausted? See "SLO 2: DB Connection Pool" section below
   - **Event source:** Is Horizon listener stuck? Check `disciplr_horizon_listener_lag`
   - **External APIs:** Check logs for rate-limiting or connectivity issues

4. **Scale horizontally if needed**
   - If sustained demand spike (not a crash), add worker replicas: increase `WORKER_CONCURRENCY` or add more pods
   - Monitor queue depth as new workers spin up; it should decline within 2-3 minutes

5. **If queue is draining naturally**
   - No action needed; workers are catching up
   - Continue monitoring for another 10 minutes

### Escalation

| Condition | Action | Timeline |
|-----------|--------|----------|
| Warning for > 15 minutes | Page secondary on-call engineer | Notify immediately |
| Critical for > 5 minutes | Page team lead (on-call manager) | Notify immediately |
| Critical + DB pool exhausted | Page DB owner + team lead | Notify immediately |
| Queue not draining after worker restart | Escalate to architecture team | Within 10 minutes |

### Silence Guidance

**When to silence:**
- Planned maintenance window (e.g., code rollout, worker upgrade): silence for duration + 30 minutes buffer
- Known bulk job processing (e.g., nightly exports): silence with explicit duration

**When NOT to silence:**
- Never silence during production incidents without team lead approval
- Never silence for > 1 hour without explicit authorization

**Silence example (Alertmanager):**
```yaml
silence {
  matchers: [
    { name: "alertname", value: "JobQueueDepthWarning", isRegex: false },
    { name: "alertname", value: "JobQueueDepthCritical", isRegex: false }
  ]
  startsAt: "2024-03-28T02:00:00Z"
  endsAt: "2024-03-28T04:00:00Z"
  createdBy: "oncall-engineer@example.com"
  comment: "Planned bulk job processing window"
}
```

---

## SLO 2: DB Connection Pool

### What it Measures

The database connection pool (`disciplr_db_available_connections` and `disciplr_db_waiting_clients`) tracks:
- **Available:** Idle connections ready for use
- **Waiting:** Requests queued for a connection (connection starvation)

A depleted pool (available ≈ 0, waiting > 0) causes request latency spikes and can lead to cascading failures. Pool exhaustion commonly results from:
- Long-running queries holding connections
- Connection leaks (connections not returned to pool)
- Traffic spike exceeding pool capacity
- Unresponsive database instance

### SLO Target

- **Warning threshold:** Pool utilization > 80% for > 5 minutes
  - Utilization = (max – available) / max
  - Example: If max=10 and available=2, utilization = 80%
- **Critical threshold:** Pool utilization > 95% for > 1 minute
  - Example: If max=10 and available=0, utilization = 100%
- **SLO:** Pool utilization < 80% for 99.5% of the time over a 7-day rolling window
- **Target availability:** 99.5% (0.5% failure budget ≈ 5 minutes per 7 days)

### Prometheus Alert Rules

Assuming max pool size = 10 (adjust `max_pool_size` if different):

```yaml
- alert: DBPoolUtilizationWarning
  expr: |
    (10 - disciplr_db_available_connections) / 10 > 0.80
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Database pool utilization elevated"
    description: "DB pool utilization is {{ $value | humanizePercentage }} (warning: > 80%). Available connections: {{ $value }}. Waiting clients: {{ $value }}. Check for slow queries or connection leaks."

- alert: DBPoolUtilizationCritical
  expr: |
    (10 - disciplr_db_available_connections) / 10 > 0.95
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "Database pool utilization critical"
    description: "DB pool utilization is {{ $value | humanizePercentage }} (critical: > 95%). Available connections: {{ $value }}. Waiting clients: {{ $value }}. Requests are being blocked."

- alert: DBWaitingClientsHigh
  expr: disciplr_db_waiting_clients > 2
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High number of clients waiting for DB connections"
    description: "{{ $value }} clients waiting for a connection. Check for slow queries or increase pool size."
```

### Remediation Steps

1. **Check current pool state** (< 2 minutes)
   ```bash
   curl /api/metrics | grep -E 'disciplr_db_available|disciplr_db_waiting'
   ```
   - Record available connections and waiting clients

2. **Query database for slow or blocked queries** (2-5 minutes)
   ```sql
   -- PostgreSQL: show long-running queries
   SELECT pid, now() - pg_stat_activity.query_start AS duration, query
   FROM pg_stat_activity
   WHERE (now() - pg_stat_activity.query_start) > interval '30 seconds'
   ORDER BY duration DESC;

   -- MySQL: show process list
   SHOW PROCESSLIST;
   ```

3. **Investigate root cause**
   - **Long-running query:** Identify the slow query and kill it if safe (consult team lead first)
     ```sql
     -- PostgreSQL (CAUTION: check with team before executing)
     SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = <pid>;
     ```
   - **Connection leak:** Check application logs for unclosed connections or missing `.close()` calls
   - **Traffic spike:** Is request rate elevated? Check application metrics; may need horizontal scaling

4. **Increase pool size if at capacity limit** (5-10 minutes)
   - Edit `DB_POOL_MIN` and `DB_POOL_MAX` in environment or config file
   - Restart app server(s) to apply changes
   - Monitor pool metrics; available should increase

5. **Monitor pool recovery** (ongoing)
   - Watch `disciplr_db_available_connections` rise back above 80% utilization threshold
   - If not recovering within 5 minutes, escalate

### Escalation

| Condition | Action | Timeline |
|-----------|--------|----------|
| Warning for > 10 minutes | Notify DB owner / platform team | Within 10 minutes |
| Critical | Page DB owner + team lead | Immediately |
| Critical + unable to identify slow query | Page database administrator (DBA) | Within 5 minutes |
| Multiple alerts + cascading latency | Declare SEV-1 incident | Immediately |

### Silence Guidance

**Only silence during:**
- Planned database maintenance windows (backups, reindex operations): silence for maintenance duration + 1 hour
- Expected traffic spikes during load testing: silence explicitly by duration and reason

**Never silence without:**
- Confirmation from DB owner or DBA
- Clear understanding of root cause
- Documented reason in Alertmanager

---

## SLO 3: Listener Lag

### What it Measures

The Horizon listener lag (`disciplr_horizon_listener_lag`) tracks how many ledgers behind our local ledger reader is compared to the live Horizon stream. This metric is measured in **ledger distance**, not time.

High listener lag indicates:
- Event processing is falling behind the blockchain
- Listener process has crashed or is unresponsive
- Database writes are slow or blocked (see "SLO 2: DB Connection Pool")
- Network connectivity to Horizon is degraded

Listener lag directly affects feature SLOs: vault state machines, validation callbacks, and event webhooks depend on low listener lag to process events promptly.

### SLO Target

- **Warning threshold:** Lag > 30 ledgers for > 5 minutes
  - Ledger intervals ≈ 5 seconds per ledger, so 30 ledgers ≈ 150 seconds behind
- **Critical threshold:** Lag > 120 ledgers for > 2 minutes
  - 120 ledgers ≈ 600 seconds (10 minutes) behind
- **SLO:** Listener lag < 30 ledgers for 99% of the time over a 7-day rolling window
- **Target availability:** 99% (1% failure budget ≈ 10 minutes per 7 days)

### Prometheus Alert Rules

```yaml
- alert: ListenerLagWarning
  expr: disciplr_horizon_listener_lag > 30
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Listener lag elevated"
    description: "Horizon listener lag is {{ $value }} ledgers (threshold: 30). Event processing is falling behind. Check listener process and DB pool."

- alert: ListenerLagCritical
  expr: disciplr_horizon_listener_lag > 120
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Listener lag critical"
    description: "Horizon listener lag is {{ $value }} ledgers (threshold: 120). Listener is > 10 minutes behind blockchain. Events are severely delayed."
```

### Remediation Steps

1. **Check listener lag and status** (< 2 minutes)
   ```bash
   curl /api/metrics | grep disciplr_horizon_listener_lag
   ```
   - Record lag value and timestamp

2. **Verify listener process is running** (1-2 minutes)
   ```bash
   # Check if listener pod/container is up
   docker ps | grep listener
   # Or for systemd
   systemctl status disciplr-listener
   ```
   - If down, restart: `docker restart disciplr-listener` or `systemctl restart disciplr-listener`

3. **Check listener logs for errors** (2-5 minutes)
   ```bash
   docker logs --tail 100 disciplr-listener | grep -i error
   # Or
   journalctl -u disciplr-listener -n 100
   ```
   - Look for network errors, database connection failures, or Horizon API errors

4. **Check database connection pool** (2 minutes)
   - If DB pool is exhausted (see "SLO 2: DB Connection Pool"), database writes are blocking listener
   - Follow DB pool remediation steps

5. **Check Horizon connectivity** (3-5 minutes)
   - Verify Horizon endpoint is reachable: `curl https://horizon.stellar.org/`
   - Check if Horizon is healthy and not undergoing maintenance
   - Check application logs for Horizon API errors (rate limiting, timeouts)

6. **Check listener backlog**
   - Some lag is expected after restart or during network blips
   - Listener should catch up automatically; monitor for 5 minutes
   - If lag is not decreasing, escalate

### Escalation

| Condition | Action | Timeline |
|-----------|--------|----------|
| Warning for > 15 minutes | Notify service owner | Within 15 minutes |
| Critical for > 5 minutes | Page on-call lead + service owner | Immediately |
| Listener process crashed | Restart and investigate logs; page if fails to recover | Within 5 minutes |
| DB pool + listener lag both elevated | Follow "Critical + cascading failure" escalation | Immediately |

### Silence Guidance

**When to silence:**
- Known event backfill operations (e.g., historical ledger replay): silence explicitly during backfill window
- Planned Horizon maintenance: silence during announced maintenance + 1 hour buffer

**When NOT to silence:**
- During production outages
- Without documented business reason
- Never silence critical alerts for > 1 hour without explicit approval

---

## SLO 4: Outbox Relay Lag (Informational)

### What it Measures

Outbox relay lag (`disciplr_outbox_relay_lag_seconds`) measures the age of the oldest unprocessed row in the outbox table. The outbox pattern ensures reliable event delivery even if the relay process crashes.

This is an **informational SLO** (not critical path), but high values indicate:
- Relay worker is stuck or crashed
- Database is slow (see "SLO 2: DB Connection Pool")
- Downstream webhook receivers are slow or failing

### SLO Target

- **Warning threshold:** Lag > 300 seconds (5 minutes) for > 10 minutes
- **Critical threshold:** Lag > 3600 seconds (1 hour) for > 5 minutes

### Prometheus Alert Rule

```yaml
- alert: OutboxRelayLagHigh
  expr: disciplr_outbox_relay_lag_seconds > 300
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Outbox relay lag elevated"
    description: "Oldest unprocessed outbox row is {{ $value | humanizeDuration }} old (threshold: 300s). Relay worker may be stuck."

- alert: OutboxRelayLagCritical
  expr: disciplr_outbox_relay_lag_seconds > 3600
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Outbox relay lag critical"
    description: "Oldest unprocessed outbox row is {{ $value | humanizeDuration }} old. Webhooks are severely delayed."
```

### Quick Remediation

1. Check relay worker is running
2. Restart if needed: `docker restart disciplr-relay` or equivalent
3. Check database pool (see "SLO 2: DB Connection Pool")
4. Check webhook subscriber health: slow receivers can block relay

---

## General Escalation Policy

### Severity Levels

| Severity | Definition | Initial Response SLA | Escalation SLA |
|----------|------------|----------------------|-----------------|
| **Warning** | Threshold exceeded but service functional | 30 minutes | If unresolved > 15 minutes, escalate |
| **Critical** | Service degraded or at risk of outage | 5 minutes | If unresolved > 5 minutes, escalate to team lead |
| **Emergency** | Service outage or data loss risk | 1 minute | Immediate escalation |

### Escalation Contacts

**Primary escalation:**
- Team lead (on-call manager) — page via PagerDuty
- Service owner — slack @service-owner-oncall

**Secondary escalation:**
- Platform/infrastructure team — #incidents Slack channel
- Database team — page DBA on-call
- Stellar foundation (if Horizon-related) — internal escalation docs

### Acknowledgment & Communication

1. **Acknowledge alert immediately** (< 5 minutes for critical)
   - In PagerDuty, select "Acknowledged"
   - Post in #incidents Slack channel: `@oncall acknowledging: [alert name] [context]`

2. **Provide status updates** (every 10 minutes during active incident)
   - What you've checked so far
   - Current hypothesis
   - Actions in progress or planned

3. **Escalate early** — don't wait for alert to resolve on its own
   - If you're uncertain about root cause after 5 minutes, escalate
   - If remediation steps aren't working, escalate

---

## Common Scenarios & Playbooks

### Scenario 1: Multiple Alerts (Queue Depth + DB Pool + Listener Lag)

**Pattern:** Cascading failure; all three SLOs breached simultaneously

**Root cause is usually:** Traffic spike → DB connection pool exhausted → listener slows down → queue backs up

**Actions (in order):**
1. Check DB pool immediately (SLO 2 remediation steps 1-3)
2. Identify and kill slow queries if blocking
3. Scale DB pool size if at capacity
4. Monitor queue depth and listener lag; they should recover as DB recovers
5. If not recovering, escalate to platform team + DBA

### Scenario 2: Queue Depth High but DB Pool Healthy

**Root cause is likely:** Worker process crashed or is stuck

**Actions:**
1. Check if worker processes are running: `ps aux | grep worker`
2. If down, restart: `docker restart disciplr-workers`
3. Monitor queue depth; should decline within 2-3 minutes
4. Check worker logs for repeated errors: `docker logs disciplr-workers --tail 50`
5. If errors indicate external dependency failure, investigate that service

### Scenario 3: Listener Lag High but DB Pool Healthy & Queue Shallow

**Root cause is likely:** Network connectivity or Horizon API issue

**Actions:**
1. Verify Horizon endpoint is reachable: `curl -I https://horizon.stellar.org/`
2. Check listener logs: `docker logs disciplr-listener --tail 50`
3. If Horizon errors, wait for Horizon to recover (external dependency)
4. If network errors, check infrastructure / firewall rules
5. Restart listener: `docker restart disciplr-listener`

### Scenario 4: Alert Woke You Up but Metrics Look Fine Now

**Pattern:** Alert fired 5 minutes ago, but current metrics are normal

**Possible causes:**
- Transient spike (legitimate, self-healed)
- Intermittent issue that recurred
- Alert threshold may be too sensitive

**Actions:**
1. Check alert history: did it re-fire multiple times? If yes, investigate
2. Check application logs around alert fire time for clues
3. If single occurrence and logs show no errors, close alert (may be tuning issue)
4. Document in incident log and discuss tuning at next retro

---

## Alert Rule Examples (Complete Prometheus Config)

Save as `prometheus-rules.yml` and include in Prometheus configuration:

```yaml
groups:
  - name: disciplr_slos
    interval: 30s
    rules:
      # Queue Depth SLOs
      - alert: JobQueueDepthWarning
        expr: disciplr_job_queue_depth > 100
        for: 5m
        labels:
          severity: warning
          team: disciplr
        annotations:
          summary: "Job queue depth elevated"
          description: "Current queue depth: {{ $value }}. Warning threshold: 100. Investigate if workers are lagging or have crashed."
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-1-job-queue-depth"

      - alert: JobQueueDepthCritical
        expr: disciplr_job_queue_depth > 500
        for: 2m
        labels:
          severity: critical
          team: disciplr
        annotations:
          summary: "Job queue depth critical"
          description: "Current queue depth: {{ $value }}. Critical threshold: 500. Immediate intervention required."
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-1-job-queue-depth"

      # DB Pool SLOs
      - alert: DBPoolUtilizationWarning
        expr: |
          (10 - disciplr_db_available_connections) / 10 > 0.80
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Database pool utilization elevated"
          description: "Pool utilization: {{ $value | humanizePercentage }}. Available connections: {{ $value }}. Waiting clients: {{ $value }}"
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-2-db-connection-pool"

      - alert: DBPoolUtilizationCritical
        expr: |
          (10 - disciplr_db_available_connections) / 10 > 0.95
        for: 1m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Database pool utilization critical"
          description: "Pool utilization: {{ $value | humanizePercentage }}. Available connections: {{ $value }}. Requests are being blocked."
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-2-db-connection-pool"

      - alert: DBWaitingClientsHigh
        expr: disciplr_db_waiting_clients > 2
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "High number of clients waiting for DB connections"
          description: "Waiting clients: {{ $value }}. Check for slow queries or consider increasing pool size."
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-2-db-connection-pool"

      # Listener Lag SLOs
      - alert: ListenerLagWarning
        expr: disciplr_horizon_listener_lag > 30
        for: 5m
        labels:
          severity: warning
          team: disciplr
        annotations:
          summary: "Listener lag elevated"
          description: "Listener lag: {{ $value }} ledgers (threshold: 30). Event processing falling behind."
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-3-listener-lag"

      - alert: ListenerLagCritical
        expr: disciplr_horizon_listener_lag > 120
        for: 2m
        labels:
          severity: critical
          team: disciplr
        annotations:
          summary: "Listener lag critical"
          description: "Listener lag: {{ $value }} ledgers (threshold: 120). Listener > 10 minutes behind."
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-3-listener-lag"

      # Outbox Relay SLOs (Informational)
      - alert: OutboxRelayLagHigh
        expr: disciplr_outbox_relay_lag_seconds > 300
        for: 10m
        labels:
          severity: warning
          team: disciplr
        annotations:
          summary: "Outbox relay lag elevated"
          description: "Oldest outbox row: {{ $value | humanizeDuration }} old (threshold: 300s)."
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-4-outbox-relay-lag-informational"

      - alert: OutboxRelayLagCritical
        expr: disciplr_outbox_relay_lag_seconds > 3600
        for: 5m
        labels:
          severity: critical
          team: disciplr
        annotations:
          summary: "Outbox relay lag critical"
          description: "Oldest outbox row: {{ $value | humanizeDuration }} old (threshold: 3600s). Webhooks severely delayed."
          runbook: "https://github.com/Disciplr-Org/Disciplr-backend/blob/main/docs/runbooks/on-call-slo.md#slo-4-outbox-relay-lag-informational"
```

---

## Cross-References

- **[operations-metrics.md](../operations-metrics.md)** — Detailed gauge definitions, security, and implementation details
- **[horizon-listener.md](../horizon-listener.md)** — Horizon listener architecture and troubleshooting
- **[jobs.md](../jobs.md)** — Background job system design and configuration
- **[operations.md](../operations.md)** — General operational procedures
- **[PagerDuty SLA Docs](https://support.pagerduty.com/docs/service-level-agreements)** — SLA definitions and escalation policies

---

## Document Maintenance

**Last reviewed:** June 27, 2026  
**Review frequency:** Every 3 months or after major incidents  
**Owners:** On-call lead, platform team  

To update this runbook:
1. Ensure gauge names match `src/routes/metrics.ts`
2. Update thresholds based on observed production behavior
3. Add new SLOs as new gauges are added
4. Document any threshold tuning decisions in commit messages
5. Notify all on-call engineers of changes via #incidents channel

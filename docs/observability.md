# Observability & Tracing Operations Guide

## Purpose

This guide describes the end-to-end observability stack in Disciplr backend: how request context flows from inbound HTTP through the Express middleware, the Horizon listener, and background jobs; what Prometheus metrics and structured logs are emitted; and how to correlate traces, logs, and metrics during an incident.

**Target audience:** On-call engineers, service owners, incident commanders.
**Related runbooks:**
- [On-Call SLO and Alerting Runbook](runbooks/on-call-slo.md) — SLO targets, alert rules, escalation procedures.
- [Database Metrics & Operations](operations-metrics.md) — Prometheus scraper auth, gauge definitions, pool health.

---

## Stack Summary

| Layer | Mechanism | Emitter |
|------|-----------|---------|
| Request context | Correlation ID (generated or forwarded) | `src/middleware/logger.ts`, `src/middleware/requestLogger.ts` |
| Structured logs | Pino JSON with redaction | `src/middleware/logger.ts` |
| HTTP metrics (RED) | `prom-client` Counter + Histogram | `src/observability/httpMetrics.ts` |
| System/job/listener metrics | `prom-client` Gauges (custom registry) | `src/routes/metrics.ts` |
| Default process metrics | `prom-client` built-in collectors | `src/routes/metrics.ts` (`collectDefaultMetrics`) |

**Tracing status:** The codebase does **not** currently use OpenTelemetry. Request identity is carried via a `correlationId` (not a W3C `traceparent`). There is no span-based distributed trace export. The correlation ID is the closest equivalent to a trace ID for log correlation; see [Correlation ID ↔ Trace ID](#correlation-id--trace-id).

---

## Context Propagation Path

### 1. Inbound HTTP → Express Middleware

1. `httpMetricsMiddleware` (`src/app.ts:19`, `src/observability/httpMetrics.ts:38`) records request start time and emits `http_requests_total` + `http_request_duration_seconds` on `res.finish`.
2. `requestLogger` (`src/middleware/requestLogger.ts:49`) extracts or generates a `correlationId` via `getOrGenerateCorrelationId` (`src/middleware/logger.ts:103`), attaches it to `req.correlationId` and creates a Pino child logger at `req.logger`.
3. The correlation ID is derived from inbound headers in priority order:
   - `x-correlation-id`
   - `x-request-id`
   - Generated fallback: `${Date.now()}-${random}`
4. `errorHandler` (`src/middleware/errorHandler.ts`) echoes `x-request-id` back in error responses — note it does **not** echo the generated correlation ID, so clients receiving a fallback ID cannot map the response to a log line by ID alone.

### 2. Application Code

Handlers should use `req.logger` (the correlation-scoped Pino child) so log lines carry the `correlationId` field. The root `logger` singleton (`src/middleware/logger.ts:88`) is shared by modules without request context (e.g., `src/security/abuse-monitor.ts`).

**Log-line fields** (common envelope):

```
{ level, service: 'disciplr-backend', correlationId, event, timestamp, ... }
```

- `http.request` events (`requestLogger.ts:106`): `req.{method,url,path,headers,body,...}`, `res.{statusCode,headers}`, `durationMs`.
- `horizon.*` events: `contractAddress`, `lastLedger`, `attempts`, `error`, `stack`.
- `security.cors_rejected` (`src/app.ts:142`): `origin`.
- `app_error` / `unhandled_error` (`errorHandler.ts`): `code`, `status`, `method`, `path`, `requestId`, `message`.

### 3. Horizon Listener (separate process)

The Horizon listener runs as a **separate Node process** (`src/services/horizonListenerMain.ts`), launched via `tsx src/services/horizonListenerMain.ts`. Because it is a separate process:

- It inherits **no** Express request context, no `req.correlationId`, no `req.logger`.
- All logging is via `console.log/warn/error(JSON.stringify({...}))` with no correlation ID and no trace ID.
- The `HorizonListener` constructor (`src/services/horizonListener.ts:40`) accepts only `config, eventProcessor, db, checkpointStore` — no logger or context bag.

**Implication:** Events processed by the listener cannot be correlated back to an originating HTTP request via the current correlation-ID mechanism. The listener's logs are correlated by `eventId`, `contractAddress`, and `lastLedger` only.

### 4. Background Jobs

The in-memory job queue (`src/jobs/queue.ts`) and `BackgroundJobSystem` (`src/jobs/system.ts`) carry **no trace context**:

- `InternalQueuedJob` (`src/jobs/queue.ts:10`) has fields `id, type, payload, attempt, maxAttempts, createdAt, runAt, leasedAt` — no `traceId`/`correlationId`.
- `runJob()` (`src/jobs/queue.ts:434`) passes only `{ jobId, attempt }` to handlers.
- Recurring scheduler jobs (`src/jobs/system.ts:276`) are timer-triggered and have no originating request.

**Implication:** Job executions are not correlated to the request that enqueued them. Job logs must be correlated by `jobId` and `type`.

---

## Correlation ID ↔ Trace ID

There is **no OpenTelemetry trace ID** in this codebase. The `correlationId` field on Pino log lines serves as the de-facto trace identifier for log correlation within the API process.

| Concept | Exists? | Location |
|--------|---------|----------|
| W3C `traceparent` header parsing | No | — |
| OTel span context propagation | No | — |
| `correlationId` (log-scoped) | Yes | `src/middleware/logger.ts:93-111` |
| `correlationId` on `req` | Yes | `src/middleware/requestLogger.ts:62` |
| `x-request-id` echoed in error responses | Yes | `src/middleware/errorHandler.ts` |
| `correlationId` echoed in responses | **No** | — |
| Correlation ID propagated to Horizon listener | **No** | Separate process |
| Correlation ID propagated to jobs | **No** | No context field on `InternalQueuedJob` |

**Triage guidance:** To correlate a request during an incident, use the `correlationId` from the `http.request` log line. Search logs for that exact `correlationId` value. For the Horizon listener and jobs, correlation must be done via time window and `eventId`/`jobId` rather than a shared trace ID.

---

## Exported Metrics

All custom metrics are registered on a dedicated `prom-client` Registry (`src/routes/metrics.ts:10`, exported as `metricsRegistry`). Default process metrics (`process_*`, `nodejs_*`, `gc_*`) are also collected on this registry via `collectDefaultMetrics`.

### HTTP RED Metrics

Defined in `src/observability/httpMetrics.ts`. **Note:** these are registered on the **default global registry**, not the application's `metricsRegistry`, so they are not currently exposed on the `/api/metrics` scrape endpoint.

| Name | Type | Labels | Description |
|------|------|--------|-------------|
| `http_requests_total` | Counter | `method`, `route`, `status_class` | Total inbound HTTP requests handled. |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_class` | Latency distribution in seconds. Buckets: 0.005–10s. |

### System Gauges

All defined in `src/routes/metrics.ts`. Aggregate-only — no tenant/org/user labels.

| Name | Type | Description | SLO / Alert Use |
|------|------|-------------|-----------------|
| `disciplr_job_queue_depth` | Gauge | Current depth of the background job queue | [SLO 1](runbooks/on-call-slo.md#slo-1-job-queue-depth): warning >100/5m, critical >500/2m |
| `disciplr_job_failed_total` | Gauge | Total number of failed jobs | Trend monitoring (note: semantically a counter; emitted as gauge) |
| `disciplr_db_available_connections` | Gauge | Available DB connections in pool | [SLO 2](runbooks/on-call-slo.md#slo-2-db-connection-pool): warning >80%/5m, critical >95%/1m |
| `disciplr_db_waiting_clients` | Gauge | Clients waiting for a DB connection | [SLO 2](runbooks/on-call-slo.md#slo-2-db-connection-pool): warning >2/5m |
| `disciplr_horizon_listener_lag` | Gauge | Listener lag in ledgers | [SLO 3](runbooks/on-call-slo.md#slo-3-listener-lag): warning >30/5m, critical >120/2m |
| `disciplr_outbox_relay_lag_seconds` | Gauge | Age of oldest unprocessed outbox row (s) | [SLO 4](runbooks/on-call-slo.md#slo-4-outbox-relay-lag-informational): warning >300s/10m, critical >3600s/5m |
| `disciplr_webhook_breaker_closed` | Gauge | Subscribers with closed circuit breaker | Capacity planning |
| `disciplr_webhook_breaker_open` | Gauge | Subscribers with open circuit breaker | Incident detection |
| `disciplr_webhook_breaker_half_open` | Gauge | Subscribers with half-open circuit breaker | Recovery monitoring |
| `disciplr_webhook_dispatch_in_flight` | Gauge | Webhook deliveries currently in flight | Saturation monitoring |
| `disciplr_webhook_dispatch_queue_depth` | Gauge | Webhook deliveries waiting in queue | Backpressure detection |
| `disciplr_event_throughput_events_per_sec` | Gauge | Event processing throughput (events/sec) | Throughput trending |

### Default Process Metrics

Enabled via `client.collectDefaultMetrics({ register })` at `src/routes/metrics.ts:13`. Includes `process_cpu_seconds_total`, `process_resident_memory_bytes`, `nodejs_heap_size_total_bytes`, `nodejs_eventloop_lag_seconds`, and GC metrics. See [prom-client docs](https://github.com/siimon/prom-client#default-metrics) for the full list.

---

## Scrape Endpoint

`GET /api/metrics` is mounted at `src/app.ts:177` behind JWT auth, admin RBAC, and a rate limiter (20 req/min). It returns the contents of the custom `metricsRegistry`.

For scraper authentication details (token, IP allowlist, audit logging), see [Database Metrics & Operations](operations-metrics.md#prometheus-scraper-authentication).

---

## Correlating Traces, Logs, and Metrics During Triage

### Scenario: Investigating a slow request

1. **Find the request in logs.** Search Pino JSON logs for the `correlationId` (from `x-correlation-id` header or the `http.request` log line):
   ```
   jq 'select(.correlationId == "1719600000-abc123xyz")' < logs.jsonl
   ```
2. **Check HTTP RED metrics.** Query Prometheus for the route and status class:
   ```
   rate(http_request_duration_seconds_sum{route="/api/vaults/:id"}[5m])
   /
   rate(http_request_duration_seconds_count{route="/api/vaults/:id"}[5m])
   ```
3. **Check system gauges at the time window.** Did the slow request coincide with pool exhaustion or queue growth?
   ```
   disciplr_db_available_connections
   disciplr_job_queue_depth
   ```
4. **Cross-reference the SLO runbook.** See [On-Call SLO and Alerting Runbook](runbooks/on-call-slo.md) for thresholds and remediation.

### Scenario: Alert fired on `disciplr_horizon_listener_lag`

1. Confirm the alert value in Prometheus.
2. Check listener logs (stdout of the `horizonListenerMain` process) for `horizon.connection_error` or `horizon.stream_error` events around the fire time.
3. Check `disciplr_db_available_connections` — listener lag often coincides with pool exhaustion.
4. Follow [SLO 3 remediation](runbooks/on-call-slo.md#slo-3-listener-lag).

### Scenario: Alert fired on `disciplr_job_queue_depth`

1. Check `disciplr_db_waiting_clients` and `disciplr_db_available_connections` for pool exhaustion.
2. Check `disciplr_horizon_listener_lag` — a stalled listener can starve job-producing events.
3. Inspect worker process health and logs.
4. Follow [SLO 1 remediation](runbooks/on-call-slo.md#slo-1-job-queue-depth).

### Correlation limitations

- **Horizon listener logs** have no `correlationId`. Correlate by time window and `eventId`/`lastLedger`.
- **Job logs** have no `correlationId`. Correlate by `jobId` and `type`.
- **HTTP RED metrics** are on the default registry, not `/api/metrics`. They must be scraped separately if needed.

---

## Log Sampling & Debug Overrides

`requestLogger` (`src/middleware/requestLogger.ts:37`) applies tail-based sampling:

- Always logged: errors (≥500), slow requests (>`LOG_SLOW_THRESHOLD_MS`, default 1000ms), statuses in `LOG_ALWAYS_LOG_STATUS` (default `500,502,503`).
- Other requests: sampled at `LOG_SAMPLE_RATE` (default `1` = 100%).

Admin debug overrides (require `ADMIN_API_KEY`):
- `x-debug-trace: <ADMIN_API_KEY>` forces debug-level logging.
- `x-log-level: <level>` with `x-admin-key: <ADMIN_API_KEY>` overrides the log level.

---

## Known Gaps & Future Work

1. **No OpenTelemetry.** No packages, SDK, or instrumentation. Correlation ID is log-only and not a W3C trace context.
2. **Correlation ID not returned in responses.** `errorHandler` echoes `x-request-id` but not the generated `correlationId`.
3. **HTTP RED metrics on wrong registry.** `http_requests_total` / `http_request_duration_seconds` are on the default registry, not the app's `metricsRegistry`, so they are not exposed on `/api/metrics`.
4. **Duplicate metric registration.** `disciplr_webhook_dispatch_in_flight` and `disciplr_webhook_dispatch_queue_depth` are declared in both `src/routes/metrics.ts` and `src/services/boundedWebhookDispatcher.ts`.
5. **`job_failed_total` typed as Gauge** despite monotonic-counter semantics.
6. **No context propagation** to the Horizon listener (separate process) or background jobs (no context field on `InternalQueuedJob`).

---

## Cross-References

- [On-Call SLO and Alerting Runbook](runbooks/on-call-slo.md) — SLO targets, alert rules, escalation.
- [Database Metrics & Operations](operations-metrics.md) — Prometheus scraper auth, gauge definitions, pool health, slow-query ring buffer.
- [Horizon Listener Architecture](horizon-listener.md) — Listener design, recovery scenarios.
- [Jobs System](jobs.md) — Background job design and configuration.
- [Operations](operations.md) — General operational procedures.

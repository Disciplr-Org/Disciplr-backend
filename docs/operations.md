# Operational Guide

This document describes how to manage the Disciplr-backend service in production.

For major data-loss or region-loss events, follow the [Disaster Recovery Runbook](runbooks/disaster-recovery.md) before re-enabling writes.

## Graceful Shutdown

Disciplr-backend implements a graceful shutdown procedure to ensure that no data is lost and all resources are cleaned up correctly.

### Triggering Shutdown

The service listens for the following signals:

- `SIGINT` (typically triggered by Ctrl+C or a container stop command)
- `SIGTERM` (typically triggered by a container orchestrator like Kubernetes or ECS)

### Shutdown Sequence

When a shutdown signal is received, the following sequence occurs:

1. **ETL Worker Stoppage**: The ETL worker stops polling for new Stellar transactions. If a run is in progress, it attempts to abort gracefully at its next checkpoint.
2. **Background Job System Stoppage**: The job system stops accepting new jobs via the `/api/jobs/enqueue` endpoint or internal schedulers. It waits up to 2 seconds for active jobs in the queue to complete.
3. **HTTP Server Closure**: The Express server stops accepting new HTTP connections and waits for active requests to finish.
4. **Database Connection Closure**: The SQLite/PostgreSQL connection is closed cleanly.

### Logging

Shutdown events are logged to stdout:

```text
[Shutdown] Received SIGTERM. Starting graceful shutdown...
[Shutdown] Stopping ETL worker...
[ETLWorker] Stop requested – draining in-flight run...
[ETLWorker] Stopped
[Shutdown] Stopping background job system...
[Shutdown] Closing HTTP server...
[Shutdown] HTTP server closed
[Shutdown] Closing database connection...
Database connection closed
[Shutdown] Graceful shutdown completed successfully
```

## HTTP Request Timeouts

Disciplr-backend configures explicit HTTP request timeouts to defend against slow-loris attacks and load balancer connection drops. The Express server enforces three timeout levels, each with a specific purpose.

### Overview

The HTTP timeout hierarchy protects the server at multiple layers:

1. **Keep-Alive Timeout** (`keepAliveTimeout`): Closes idle keep-alive sockets to prevent resource exhaustion.
2. **Headers Timeout** (`headersTimeout`): Forces closure if HTTP headers are not fully received by the deadline.
3. **Request Timeout** (`requestTimeout`): Forces closure if the entire request (headers + body) is not completed by the deadline.

### Timeout Sequence

The three timeouts must maintain strict ordering:

$$\text{keepAliveTimeout} < \text{headersTimeout} < \text{requestTimeout}$$

Default values:

- `HTTP_KEEPALIVE_TIMEOUT_MS`: **45,000 ms** (45 seconds)
- `HTTP_HEADERS_TIMEOUT_MS`: **61,000 ms** (61 seconds)
- `HTTP_REQUEST_TIMEOUT_MS`: **120,000 ms** (120 seconds)

### Rationale

#### Keep-Alive Timeout (45s)

- Closes idle sockets that are not actively transmitting data.
- Prevents accumulation of zombie connections consuming resources.
- Well below headers timeout to ensure idle sockets are cleaned before header deadlines.

#### Headers Timeout (61s)

- The Node.js server-level timeout for receiving complete HTTP headers.
- Set to **61 seconds** to accommodate AWS ALB default idle timeout of 60 seconds.
- If a client stalls while sending headers, the server will forcefully close the socket at this point.
- Protects against slow-loris attacks (attacks that send headers slowly to exhaust server resources).

#### Request Timeout (120s)

- The full request lifecycle timeout, covering both headers and body transmission.
- Allows slower uploads and downloads while preventing indefinite stalls.
- Clients sending large files have 120 seconds total to complete the transfer.
- If headers arrive but the body stalls, this timeout will trigger.

### Load Balancer Compatibility

When using AWS ALB or similar load balancers:

| Component            | Timeout   | Note                                                                   |
| -------------------- | --------- | ---------------------------------------------------------------------- |
| AWS ALB idle timeout | 60,000 ms | Default; can be customized                                             |
| `headersTimeout`     | 61,000 ms | **Slightly higher than ALB timeout** to prevent ALB closing mid-flight |
| `keepAliveTimeout`   | 45,000 ms | Closes keep-alive sockets before ALB idle timeout                      |

**Key principle**: The server should close idle connections _before_ the load balancer does, avoiding half-open connections.

### Configuration

Set environment variables to customize timeouts:

```bash
# All values in milliseconds
export HTTP_KEEPALIVE_TIMEOUT_MS=45000    # Default
export HTTP_HEADERS_TIMEOUT_MS=61000      # Default
export HTTP_REQUEST_TIMEOUT_MS=120000     # Default
```

**Important**: The application will **exit with an error** if:

- `HTTP_KEEPALIVE_TIMEOUT_MS >= HTTP_HEADERS_TIMEOUT_MS`
- `HTTP_HEADERS_TIMEOUT_MS >= HTTP_REQUEST_TIMEOUT_MS`

### Slow-Loris Attack Protection

A slow-loris attack sends HTTP headers or body data very slowly, one byte at a time, to exhaust server resources by maintaining many half-open connections.

**Disciplr-backend defenses:**

1. **Headers Timeout**: If a client takes more than 61 seconds to send complete headers, the socket is destroyed.
2. **Keep-Alive Timeout**: Idle sockets (no data flow) are terminated after 45 seconds.
3. **Request Timeout**: Even if headers arrive, an incomplete request (stalled body) times out after 120 seconds.

**Example slow-loris scenario (prevented):**

```
t=0s:    Client sends "GET / HTTP/1.1\r\n"
t=5s:    Client sends "Host: example.com\r\n"
t=10s:   Client sends "User-Agent: Mozilla\r\n"
...
t=65s:   Server closes socket (headers timeout reached)
         Request never completed, resource freed.
```

### Graceful Shutdown Interaction

During graceful shutdown (triggered by `SIGTERM`):

1. HTTP drain mode activates, rejecting new requests at the middleware level.
2. The server waits for in-flight requests to complete (default max 30 seconds via `SHUTDOWN_DRAIN_MS`).
3. If the drain deadline expires, remaining sockets are forcefully destroyed.
4. The HTTP server is closed cleanly.

**Timeout configuration does not prevent graceful shutdown**; it complements it:

- Timeouts protect against stalled clients during normal operation.
- Graceful shutdown ensures clean termination on demand.

### Monitoring and Troubleshooting

#### Check timeout configuration on startup

The server logs its configured timeouts at startup:

```
[Server] Configured HTTP timeouts: {
  keepAliveTimeout: 45000ms,
  headersTimeout: 61000ms,
  requestTimeout: 120000ms
}
```

#### Request timeout errors in logs

If legitimate clients receive timeout errors, consider:

1. **Large file uploads**: Increase `HTTP_REQUEST_TIMEOUT_MS` if uploads routinely exceed 120 seconds.
2. **Slow networks**: ALB idle timeout (60s) is very aggressive; consider increasing `HTTP_HEADERS_TIMEOUT_MS`.
3. **Stalled clients**: If a specific client frequently stalls, review their network conditions.

```bash
# Example: Increase request timeout to 300 seconds for large uploads
export HTTP_REQUEST_TIMEOUT_MS=300000
```

#### Validation errors on startup

If the app exits with environment validation errors during startup, check:

```
HTTP_KEEPALIVE_TIMEOUT_MS (5000ms) must be less than HTTP_HEADERS_TIMEOUT_MS (3000ms)
```

**Fix**: Ensure timeouts follow the required ordering and are all positive integers.

### Testing

The timeout behavior is tested via `src/tests/serverTimeouts.test.ts`:

```bash
npm test -- serverTimeouts.test.ts
```

Test coverage includes:

- Stalled headers (simulated slow-loris)
- Stalled request body
- Keep-alive socket lifecycle
- Timeout ordering validation
- Graceful shutdown interaction
- Load balancer compatibility

All environment variables are validated at startup using `src/config/env.ts`. If any required variables are missing or incorrectly formatted, the application will exit with a fatal error.

| Variable                     | Default | Description                                                                                                                           |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                       | 3000    | The port the API listens on.                                                                                                          |
| `ENABLE_ETL_WORKER`          | `true`  | Set to `false` to disable the Stellar ETL worker.                                                                                     |
| `ETL_INTERVAL_MINUTES`       | 5       | How often the ETL worker syncs with Horizon.                                                                                          |
| `JOB_WORKER_CONCURRENCY`     | 2       | Number of concurrent job workers.                                                                                                     |
| `JOB_QUEUE_POLL_INTERVAL_MS` | 250     | How often the job queue checks for new work.                                                                                          |
| `JOB_HISTORY_LIMIT`          | 50      | Number of completed/failed jobs to keep in memory metrics.                                                                            |
| `DATABASE_URL`               | -       | PostgreSQL connection URL.                                                                                                            |
| `JWT_SECRET`                 | -       | Secret for signing JWTs.                                                                                                              |
| `HTTP_KEEPALIVE_TIMEOUT_MS`  | 45,000  | Keep-alive socket idle timeout (milliseconds). Must be less than `HTTP_HEADERS_TIMEOUT_MS`.                                           |
| `HTTP_HEADERS_TIMEOUT_MS`    | 61,000  | HTTP headers deadline timeout (milliseconds). Must be less than `HTTP_REQUEST_TIMEOUT_MS`. Set slightly above ALB idle timeout (60s). |
| `HTTP_REQUEST_TIMEOUT_MS`    | 120,000 | Full request lifecycle timeout (milliseconds). Protects against stalled request bodies.                                               |

## Structured Abuse Category Taxonomy (#467)

The abuse monitor now emits structured `security.abuse_detected` events instead of free-form strings, enabling downstream aggregation by anomaly class.

### Categories

| Category          | Trigger                         | Key fields                                       |
| ----------------- | ------------------------------- | ------------------------------------------------ |
| `brute-force`     | `failed_login_burst` pattern    | `failedLoginCount`, `windowMs`                   |
| `enumeration`     | `endpoint_scan` pattern         | `notFoundCount`, `distinctPathCount`, `windowMs` |
| `payload-anomaly` | `repeated_bad_requests` pattern | `badRequestCount`, `windowMs`                    |
| `rate-limit-trip` | `high_volume` pattern           | `requestCount`, `windowMs`                       |

### Admin endpoint

`GET /api/admin/abuse/category-counts` (admin token required) returns a snapshot of per-category counts:

```json
{
  "data": {
    "brute-force": 3,
    "enumeration": 1,
    "payload-anomaly": 0,
    "rate-limit-trip": 2
  }
}
```

### Log format

```json
{
  "event": "security.suspicious_pattern",
  "ip": "1.2.3.4",
  "category": {
    "type": "brute-force",
    "failedLoginCount": 6,
    "windowMs": 900000
  },
  "alertCooldownMs": 300000
}
```

# Webhook subscriptions

Tenant-scoped webhook subscriptions are exposed under `/api/webhooks`.

## Endpoints

- `POST /api/webhooks?orgId=<orgId>` creates a subscription
- `GET /api/webhooks?orgId=<orgId>` lists subscriptions for the current organization
- `GET /api/webhooks/:id?orgId=<orgId>` returns a single subscription
- `POST /api/webhooks/:id/rotate-secret?orgId=<orgId>` rotates the secret and returns it once
- `DELETE /api/webhooks/:id?orgId=<orgId>` deletes a subscription

Subscribers are stored in-memory (same pattern as API keys). Each subscriber has:

- `id` – UUID
- `url` – target endpoint
- `secret` – HMAC signing key
- `events` – event types to subscribe to (empty = wildcard)
- `active` – delivery flag

### SSRF Protection

`isUrlAllowed()` blocks loopback, link-local, and RFC-1918 addresses. If `WEBHOOK_ALLOWED_HOSTS` is set, the target hostname must also match.

## Delivery

`dispatchWebhookEvent()` sends a payload to all eligible active subscribers. Each delivery is retried with exponential backoff (max 3 attempts).

### Headers

| Header | Description |
|--------|-------------|
| `x-disciplr-signature` | `sha256=<hex-digest>` HMAC-SHA256 of the JSON body |
| `x-disciplr-event` | Event type (e.g. `vault_created`) |
| `x-disciplr-event-id` | Originating event ID in `{txHash}:{eventIndex}` format |
| `x-disciplr-delivery-timestamp` | ISO 8601 timestamp |

## Circuit Breaker

Each subscriber has an associated circuit breaker that isolates chronically failing endpoints so healthy deliveries are not delayed.

### States

| State | Behavior |
|-------|----------|
| **CLOSED** | Normal operation. Delivery proceeds. Failures increment a counter. |
| **OPEN** | All deliveries are short-circuited directly to the dead-letter queue. No HTTP requests are made. |
| **HALF_OPEN** | Exactly one probe request is allowed. Success transitions back to CLOSED; failure transitions to OPEN. |

### State Machine

```
CLOSED → (failure count ≥ threshold) → OPEN → (timeout elapses) → HALF_OPEN → (probe succeeds) → CLOSED
                                                                      → (probe fails) → OPEN
```

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `WEBHOOK_CIRCUIT_BREAKER_THRESHOLD` | `5` | Consecutive failures within the window needed to trip to OPEN |
| `WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS` | `60_000` | Sliding window (ms) for counting failures |
| `WEBHOOK_CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS` | `30_000` | Time (ms) before an OPEN breaker transitions to HALF_OPEN for a probe |

### Persistence

Breaker state is persisted in the `webhook_breaker_states` table and survives restarts. An in-memory cache is used at runtime; the cache is invalidated only on restart or via `resetBreakerCache()` (test helper).

### Metrics

Breaker state counts are exposed as Prometheus gauges at `/api/metrics`:

| Metric | Description |
|--------|-------------|
| `disciplr_webhook_breaker_closed` | Subscribers in CLOSED state |
| `disciplr_webhook_breaker_open` | Subscribers in OPEN state |
| `disciplr_webhook_breaker_half_open` | Subscribers in HALF_OPEN state |

### Window Replay (Admin)

When a subscriber endpoint was down for a maintenance window, an operator can
redeliver all dead-letter entries from a time range using the admin window-replay
endpoint.

#### `POST /api/admin/webhooks/:subscriber_id/replay`

Replays all dead-letter entries for a subscriber within `[start_time, end_time]`.
Uses the existing signing and delivery path (HMAC-SHA256, schema versioning,
circuit breaker checks).

**Authorization:** Admin only (`x-user-role: admin`).

**Request Body:**
```json
{
  "start_time": "2026-06-27T00:00:00.000Z",
  "end_time": "2026-06-28T00:00:00.000Z",
  "replay_marker": "optional-unique-idempotency-key",
  "max_events": 500
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `start_time` | string (ISO 8601) | Yes | Start of the time window (inclusive) |
| `end_time` | string (ISO 8601) | Yes | End of the time window (inclusive) |
| `replay_marker` | string | No | Idempotency key — re-using the same marker returns cached results without re-sending deliveries |
| `max_events` | integer | No | Rate bound: maximum events to replay (default 500, min 1) |

**Response 200:**
```json
{
  "replayed": true,
  "count": 42,
  "success_count": 40,
  "failure_count": 2,
  "replay_marker": "optional-unique-idempotency-key"
}
```

**Response 400 (validation error):**
```json
{ "error": "start_time is required (ISO 8601)" }
```

**Response 404 (subscriber not found):**
```json
{ "error": "Subscriber not found" }
```

**Idempotency with replay_marker:**

When a `replay_marker` is provided, the endpoint stores the result keyed by that
marker. Subsequent calls with the same marker return the original result without
making any new delivery attempts. This is safe to retry on network timeouts or
interruptions.

**Rate bounding:**

The `max_events` parameter limits the number of entries processed in a single
request (default 500, cap at subscriber count). For larger windows, operators
should paginate by narrowing the time range.

**Audit log entry:**

Each replay writes an audit log entry with action `webhook.window_replay`,
including `startTime`, `endTime`, `count`, `successCount`, and `failureCount`.

---

When a delivery permanently fails (exhausts retries) or is short-circuited by an open breaker, the failed delivery is persisted to the `webhook_dead_letters` table for later inspection and replay.

### Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `subscriber_id` | UUID | Subscriber that failed to receive |
| `event_id` | TEXT | Event ID (`{txHash}:{eventIndex}`) |
| `event_type` | VARCHAR(128) | Event type |
| `payload` | JSONB | Original delivery payload |
| `last_error` | TEXT | Last error message |
| `attempts` | INTEGER | Number of delivery attempts |
| `failed_at` | TIMESTAMPTZ | When the delivery permanently failed |
| `replayed_at` | TIMESTAMPTZ | When the entry was replayed (null if not yet) |

### Admin API

#### GET `/api/admin/webhooks/dead-letters`

List dead-letter entries with optional `subscriber_id` filter.

Query params: `limit`, `offset`, `subscriber_id`

Response:
```json
{
  "webhook_dead_letters": [...],
  "count": 10,
  "total": 42,
  "limit": 50,
  "offset": 0,
  "has_more": true
}
```

#### POST `/api/admin/webhooks/dead-letters/:id/replay`

Replays a dead-letter entry. Validates the URL is still allowed, then re-delivers to the subscriber's in-memory handler. Stamps `replayed_at` on success.

Response (202):
```json
{ "replayed": true }
```

Response (404):
```json
{ "error": "Dead letter not found or already replayed" }
```

## Delivery Analytics

Every delivery attempt (success or failure, including retried attempts) is persisted to the `webhook_delivery_attempts` table. This powers the per-subscriber stats endpoint and allows operators to diagnose flaky integrations without querying raw tables.

### Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `subscriber_id` | UUID | Subscriber that was targeted |
| `event_id` | TEXT | Event ID (`{txHash}:{eventIndex}`) |
| `event_type` | VARCHAR(128) | Event type |
| `status_code` | INTEGER | HTTP status code from the last attempt (null on timeout or circuit-breaker short-circuit) |
| `success` | BOOLEAN | Whether the delivery ultimately succeeded |
| `latency_ms` | INTEGER | Wall-clock time in ms including all retry backoffs |
| `error` | TEXT | Error message on failure (null on success) |
| `attempt_number` | INTEGER | Total number of HTTP attempts made (1–3) |
| `attempted_at` | TIMESTAMPTZ | When the delivery was finalized |

Indexed on `(subscriber_id, attempted_at)` for efficient time-windowed aggregations.

### Admin API — Delivery Stats

#### GET `/api/admin/webhooks/:id/stats`

Returns aggregated delivery analytics for a single subscriber over a configurable time window. Admin-only.

**Query params:**

| Param | Default | Description |
|-------|---------|-------------|
| `window` | `24h` | Time window — format `<N>h` (1–72) or `<N>d` (1–3). Max 72 h. |

**Response (200):**
```json
{
  "subscriber_id": "3f1a...",
  "window": "24h",
  "window_start": "2026-06-28T00:00:00.000Z",
  "window_end":   "2026-06-29T00:00:00.000Z",
  "attempt_count": 120,
  "success_count": 115,
  "failure_count": 5,
  "success_rate": 0.958,
  "p50_latency_ms": 130,
  "p95_latency_ms": 420,
  "last_failure_reason": "HTTP 503",
  "breaker_state": "CLOSED"
}
```

- `success_rate` is rounded to 3 decimal places (0–1).
- `p50_latency_ms` / `p95_latency_ms` are `null` when no attempts exist in the window.
- `last_failure_reason` is taken from the most recent `webhook_dead_letters` entry within the window.
- `breaker_state` is the live circuit-breaker state (`CLOSED`, `OPEN`, `HALF_OPEN`, or `null` if no state has been recorded).

**Error responses:**

| Status | Condition |
|--------|-----------|
| 400 | Invalid or out-of-range `window` parameter |
| 401 | Missing or invalid Bearer token |
| 403 | Authenticated user is not an admin |
| 404 | Subscriber ID not found |

## Test-Ping Endpoint

`POST /api/webhooks/:id/test` lets subscribers self-verify their delivery URL and HMAC wiring before real vault events start flowing.

### Authorization

- Caller must be authenticated (Bearer JWT).
- The subscriber must belong to the caller's organization (`enterpriseId` in the JWT must match `organizationId` on the subscriber). Cross-org pings return **403**.

### Rate Limiting

5 requests per subscriber per 60 seconds to prevent abuse as an SSRF probe.

### Request

```http
POST /api/webhooks/{subscriberId}/test
Authorization: Bearer <token>
```

No request body required.

### Response (200 — always returned for delivery attempts)

```json
{
  "url": "https://example.com/webhook",
  "events": ["vault_created"],
  "active": true
}
```

The `url` must be a permitted public HTTP(S) URL. Secrets are returned only on creation and rotation.

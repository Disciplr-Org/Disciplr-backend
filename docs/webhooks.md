# Webhooks

## Overview

The webhook system delivers lifecycle events (e.g. `vault_created`, `vault_completed`, `vault_failed`, `vault_cancelled`) to registered subscriber URLs via HTTP POST with HMAC-SHA256 signature verification.

## Subscriber Management

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

## Dead-Letter Queue

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

## Testing

Run webhook tests:
```bash
npm test -- --testPathPattern=webhooks
```

DLQ tests require a PostgreSQL database (`DATABASE_URL`). Without it, they are skipped gracefully.

---

# Webhook Delivery System

The webhook system delivers vault lifecycle events to registered HTTP endpoints. Subscribers are stored in PostgreSQL and scoped per organization.

## Storage Model

Webhook subscribers are stored in the `webhook_subscribers` table:

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` (PK, auto-generated) | Unique subscriber identifier |
| `organization_id` | `varchar(255)` | Owning organization (NOT NULL) |
| `url` | `varchar(2048)` | Target webhook URL |
| `secret` | `text` | HMAC signing secret |
| `events` | `jsonb` | Array of event types to receive; empty array = wildcard (all events) |
| `active` | `boolean` | Whether the subscriber is active |
| `schema_version` | `integer` (default `1`) | Payload schema version (see Payload Schema Versioning) |
| `created_at` | `timestamptz` | Creation timestamp |
| `updated_at` | `timestamptz` | Last update timestamp |

Index: `(organization_id, active)` for efficient org-scoped lookups.

## Secret Handling Decision

The `secret` column stores the HMAC signing secret in plaintext. Hashing is not viable because the raw secret is required to compute HMAC-SHA256 signatures for outgoing webhook requests.

**Recommendation for production:** Encrypt the secret at rest using one of:
- PostgreSQL `pgcrypto` extension (`pgp_sym_encrypt` / `pgp_sym_decrypt`)
- Application-level AES-256-GCM encryption before storage, with the encryption key managed via a secrets manager (AWS KMS, HashiCorp Vault)

The trade-off is that the encryption key must be available to the application at runtime to decrypt secrets for signing, which shifts the protection boundary from the database layer to the key management layer.

## Organization Isolation

All subscriber queries are scoped by `organization_id`. When dispatching events, only subscribers belonging to the same organization as the event source receive the delivery. This prevents cross-tenant information leakage.

## API

### `addSubscriber(organizationId, url, secret, events, schemaVersion = 1)`

Creates a new webhook subscriber. The URL is validated against the SSRF allowlist (`isUrlAllowed`). Returns the created subscriber.

`events` is an array of event type strings the subscriber wants to receive. An empty array (`[]`) acts as a wildcard and subscribes to all events. Each event type is validated against `KNOWN_EVENT_TYPES`; unknown types are rejected.

Optional `schemaVersion` selects the payload envelope version (default `1`). Must be a supported version (see Payload Schema Versioning).

### `KNOWN_EVENT_TYPES`

The set of all event types the system can produce:

```
vault_created, vault_completed, vault_failed, vault_cancelled,
milestone_created, milestone_validated, settlement_summary
```

### `removeSubscriber(id)`

Deletes a subscriber by ID. Returns `true` if found.

### `listSubscribers(organizationId)`

Returns all active subscribers for an organization.

### `dispatchWebhookEvent(payload)`

Delivers an event to all eligible active subscribers for the organization specified in `payload.organizationId`. Uses exponential-backoff retry (max 3 attempts). Failures are collected per-subscriber.

---

## Payload Schema Versioning

Each subscriber selects a payload schema version (`schema_version`). The version determines the JSON envelope delivered to the subscriber's endpoint.

### Supported Versions

| Version | Envelope | Notes |
|---------|----------|-------|
| **1** (default) | `{ eventId, eventType, timestamp, data, organizationId, schema_version: 1 }` | Original shape — includes all fields from the internal payload with `schema_version` appended. |
| **2** | `{ schema_version: 2, event_type, data }` | Compact envelope. Omits `eventId`, `timestamp`, and `organizationId`. The event type key is `event_type` (snake_case). |

### Adding a Subscriber with a Specific Version

```typescript
// Defaults to version 1
await addSubscriber(orgId, url, secret, events)

// Explicit version 2
await addSubscriber(orgId, url, secret, events, 2)
```

### Delivery Behaviour

- The HTTP body delivered to the subscriber is the serialized versioned envelope.
- The `x-disciplr-signature` HMAC is computed over the versioned body, so the signature covers the full envelope.
- The `x-disciplr-event`, `x-disciplr-event-id`, and `x-disciplr-delivery-timestamp` headers are identical across all schema versions.

### Deprecation Policy

1. When a new schema version is introduced, the previous version enters **deprecated** status.
2. Deprecated versions remain functional for **90 days** after the successor version is marked stable.
3. During the deprecation window subscribers on the old version receive **warning** log lines on each delivery.
4. After the deprecation window expires the old version is **removed** and `addSubscriber` rejects it. Existing subscribers that still reference the removed version are downgraded to the earliest still-supported version and logged.
5. The `LATEST_SCHEMA_VERSION` constant always points to the current stable version.
6. The `SUPPORTED_SCHEMA_VERSIONS` set contains all versions that are neither removed nor deprecated.

---

## Outbound Webhooks
The Disciplr backend dispatches webhooks to subscribers when specific events occur. Subscribers can register to receive webhook deliveries for events such as `vault_created`, `vault_completed`, etc.

The outbound webhooks include signatures in headers which the subscriber can verify.

## Inbound Webhooks

When third-party providers (e.g., payment gateways) send webhook callbacks to our backend, we must ensure these callbacks are authentic, timely, and not replayed.

### Verification Flow

The inbound webhook endpoint uses the `webhookVerify` middleware to validate requests:
1. **Timestamp Check**: Ensures the request was generated recently.
2. **Replay Protection**: Stores a nonce combined with the timestamp. If the same nonce is seen again within the allowed time window, the request is rejected.
3. **Signature Verification**: Validates the HMAC-SHA256 signature calculated over the timestamp, nonce, and raw request body using a shared secret.

### Required Headers
Inbound webhook requests must include the following headers:
- `x-webhook-signature`: The HMAC-SHA256 signature in the format `sha256=<hex_digest>`.
- `x-webhook-timestamp`: A unix timestamp (in milliseconds) representing when the request was made.
- `x-webhook-nonce`: A unique string for the request.

### Calculating the Signature
The signature is generated as an HMAC-SHA256 digest of the following string:
`<timestamp>.<nonce>.<raw_body>`

Using the shared secret (`WEBHOOK_INBOUND_SECRET`):

```javascript
const crypto = require('crypto');

const secret = process.env.WEBHOOK_INBOUND_SECRET;
const timestamp = Date.now();
const nonce = crypto.randomUUID();
const rawBody = JSON.stringify(payload); // Ensure this matches exactly what is sent over the wire

const signatureString = `${timestamp}.${nonce}.${rawBody}`;
const digest = crypto.createHmac('sha256', secret).update(signatureString).digest('hex');
const signatureHeader = `sha256=${digest}`;
```

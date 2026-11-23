# Webhook Integration Guide

A subscriber-facing guide for verifying Disciplr webhook deliveries, handling retries, and processing events idempotently.

> **Internal design docs:** [`docs/webhooks.md`](./webhooks.md) covers the server-side architecture, circuit breaker, DB schema, and admin API. This guide focuses on what you, the subscriber, need to know to integrate.

---

## Table of Contents

1. [Overview](#overview)
2. [Registering a Subscriber](#registering-a-subscriber)
3. [Delivery Headers](#delivery-headers)
4. [Signature Verification](#signature-verification)
   - [HMAC Algorithm](#hmac-algorithm)
   - [Verified Example (Node.js)](#verified-example-nodejs)
   - [Verified Example (Python)](#verified-example-python)
   - [Secret Rotation Grace Window](#secret-rotation-grace-window)
5. [Payload Schema Versioning](#payload-schema-versioning)
   - [Version 1 (default)](#version-1-default)
   - [Version 2](#version-2)
   - [Content Negotiation](#content-negotiation)
6. [Event Types](#event-types)
7. [Idempotent Consumer Pattern](#idempotent-consumer-pattern)
8. [Retry and Backoff Behaviour](#retry-and-backoff-behaviour)
9. [Dead-Letter Queue and Replay](#dead-letter-queue-and-replay)
10. [Test-Ping Endpoint](#test-ping-endpoint)
11. [Field Masking and PII Stripping](#field-masking-and-pii-stripping)
12. [Troubleshooting](#troubleshooting)
13. [Appendix: Quick Reference](#appendix-quick-reference)

---

## Overview

Disciplr delivers vault lifecycle events and milestone updates to your registered HTTP endpoint as `POST` requests signed with **HMAC-SHA256**. Every delivery includes:

- The event payload as the request body (JSON).
- A signature header you **must verify** before trusting the payload.
- A unique event ID you **must deduplicate against** to guarantee exactly-once processing.

---

## Registering a Subscriber

Subscribers are managed through the admin API. Contact your Disciplr operator or use the admin endpoints:

```http
POST /api/admin/webhooks/subscribers
Content-Type: application/json

{
  "organization_id": "org-123",
  "url": "https://hooks.example.com/disciplr",
  "secret": "your-signing-secret",
  "events": ["vault_created", "vault_completed"]
}
```

- `secret` is a shared secret you choose. Disciplr uses it to sign every delivery to your endpoint. **Keep it safe** — anyone with the secret can forge events.
- `events` is an array of event types to receive. An empty array subscribes you to **all** event types.
- `schema_version` can be `1` (default) or `2` — see [Payload Schema Versioning](#payload-schema-versioning).

The subscriber `id` is returned in the response and can be used later for [test-pings](#test-ping-endpoint) and [secret rotation](#secret-rotation-grace-window).

> **The secret is never returned** in any API response. If you lose it, use the rotate-secret endpoint.

---

## Delivery Headers

Every webhook `POST` to your endpoint includes these headers:

| Header | Value | Example |
|--------|-------|---------|
| `x-disciplr-signature` | `sha256=<hex-digest>` — HMAC-SHA256 of the raw JSON body | `sha256=e99a18c428cb38d5f260853678922e03` |
| `x-disciplr-event` | Event type string | `vault_created` |
| `x-disciplr-event-id` | Originating event ID in `{txHash}:{eventIndex}` format | `a1b2c3d4...:0` |
| `x-disciplr-delivery-timestamp` | ISO 8601 timestamp of the event | `2026-06-28T12:00:00.000Z` |

### Signature Algorithm (exact)

```
HMAC-SHA256(secret, body)
```

Where:
- `secret` is your shared signing secret (UTF-8).
- `body` is the **raw request body bytes** as serialized JSON (must match byte-for-byte).
- The digest is encoded as a lowercase hexadecimal string.
- The final header value is `sha256=` prepended to the hex digest.

> ⚠️ Verify the signature using the **raw body** exactly as received. Do not re-serialize `JSON.parse()`d and `JSON.stringify()`d output — field ordering or formatting may differ.

---

## Signature Verification

### Verified Example (Node.js)

```javascript
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies an x-disciplr-signature header.
 *
 * @param {string} secret      - Your shared signing secret
 * @param {string} body        - Raw request body as received (string)
 * @param {string} signature   - The raw x-disciplr-signature header value
 * @returns {boolean}
 */
function verifyDisciplrSignature(secret, body, signature) {
  const expected = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`

  if (expected.length !== signature.length) {
    return false
  }

  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
}

// Example usage in an Express handler:
app.post('/webhooks/disciplr', (req, res) => {
  const rawBody = JSON.stringify(req.body) // or use req.rawBody from middleware
  const signature = req.headers['x-disciplr-signature']
  const eventType = req.headers['x-disciplr-event']
  const eventId   = req.headers['x-disciplr-event-id']

  if (!verifyDisciplrSignature(MY_SECRET, rawBody, signature)) {
    return res.status(401).send('Invalid signature')
  }

  // Process event...
  res.status(200).end()
})
```

### Verified Example (Python)

```python
import hmac
import hashlib

def verify_disciplr_signature(secret: str, body: str, signature: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"),
        body.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()

    # Constant-time comparison
    return hmac.compare_digest(expected, signature)
```

### Secret Rotation Grace Window

When your secret is rotated via the admin API, Disciplr retains your **previous secret** for a grace window (default **24 hours**, configurable via `WEBHOOK_SECRET_GRACE_WINDOW_MS`). During this window, deliveries are signed with the **new** secret, but the server can still verify the old secret for inbound verification.

**What this means for you:** After a rotation:
1. Update your endpoint to expect the new secret immediately.
2. For the grace period, either secret will verify.
3. After the grace window, only the new secret is accepted.

If you receive a signature verification failure, your expected secret may be out of sync — check whether a rotation occurred recently.

---

## Payload Schema Versioning

Each subscriber selects a payload schema version at registration. The version determines the JSON envelope delivered to your endpoint.

### Version 1 (default)

```json
{
  "eventId": "a1b2c3d4...:0",
  "eventType": "vault_created",
  "timestamp": "2026-06-28T12:00:00.000Z",
  "data": { /* event-specific fields */ },
  "organizationId": "org-123",
  "schema_version": 1
}
```

### Version 2

```json
{
  "schema_version": 2,
  "event_type": "vault_created",
  "data": { /* event-specific fields */ }
}
```

**Differences from v1:**
- `event_type` uses snake_case (not camelCase).
- `eventId`, `timestamp`, and `organizationId` are omitted.
- The envelope is more compact.

### Content Negotiation

- The `x-disciplr-signature` HMAC is computed over the versioned body — always verify against the body as received.
- The `x-disciplr-event`, `x-disciplr-event-id`, and `x-disciplr-delivery-timestamp` headers are identical across all schema versions.

| Version | Status | Notes |
|---------|--------|-------|
| **1** | Current (default) | Original envelope |
| **2** | Current | Compact envelope |

When a version enters deprecation it remains functional for **90 days** after its successor is marked stable.

---

## Event Types

| Event Type | Description |
|-----------|-------------|
| `vault_created` | A new accountability vault has been created |
| `vault_completed` | All milestones verified; vault settled successfully |
| `vault_failed` | Vault deadline passed with unverified milestones |
| `vault_cancelled` | Vault cancelled before completion |
| `milestone_created` | A milestone was added to a vault |
| `milestone_validated` | A milestone passed verification |
| `settlement_summary` | Periodic settlement aggregation |

---

## Idempotent Consumer Pattern

**Every webhook delivery includes a unique `x-disciplr-event-id`** in the format `{txHash}:{eventIndex}`. Use this as your idempotency key to guarantee exactly-once processing.

```javascript
// Recommended pattern: deduplicate by eventId
const processed = await getProcessedEventSet()

app.post('/webhooks/disciplr', async (req, res) => {
  const eventId = req.headers['x-disciplr-event-id']

  // 1. Verify signature (see section above)
  if (!verifyDisciplrSignature(MY_SECRET, rawBody, signature)) {
    return res.status(401).send('Invalid signature')
  }

  // 2. Idempotency check
  if (processed.has(eventId)) {
    return res.status(200).send('Already processed')  // Acknowledge silently
  }

  // 3. Process the event
  await processEvent(req.body)

  // 4. Record the event ID
  await recordProcessedEvent(eventId)

  // 5. Acknowledge
  res.status(200).send('OK')
})
```

**Why this matters:** Disciplr may redeliver an event if your endpoint returns a non-2xx status or if a network failure occurs. Deduplication by `eventId` ensures your system stays consistent.

**Storage options for processed IDs:**
- Database table with a unique constraint on `event_id`.
- Redis set with TTL (e.g., 7 days).
- Your existing idempotency store.

---

## Retry and Backoff Behaviour

| Property | Value |
|----------|-------|
| Max attempts | 3 |
| Initial backoff | 1,000 ms |
| Backoff multiplier | 2× |
| Max backoff | 30,000 ms |
| Jitter | ±25% (full jitter) |
| Request timeout | 10,000 ms |
| Redirects | Refused (manual redirect, not followed) |

**Flow:**
1. Disciplr sends the `POST` to your endpoint.
2. If you return `2xx`, delivery is considered successful.
3. If you return `4xx` or `5xx`, or the request times out, Disciplr retries with exponential backoff.
4. After 3 failed attempts, the event is placed in the [dead-letter queue](#dead-letter-queue-and-replay).
5. If your endpoint consistently fails, the [circuit breaker](#circuit-breaker) may trip, causing all future deliveries to skip directly to dead-letter without hitting your endpoint.

**Best practice:** Return `2xx` as quickly as possible after validating the signature and storing the `eventId` for deduplication. Process the event asynchronously in the background.

---

## Dead-Letter Queue and Replay

When delivery permanently fails (exhausted retries or circuit-breaker short-circuit), the failed delivery is persisted in the dead-letter queue.

### Admin API

#### List dead letters

```http
GET /api/admin/webhooks/dead-letters?limit=50&offset=0&subscriber_id=<id>
```

#### Replay a dead letter

```http
POST /api/admin/webhooks/dead-letters/:id/replay
```

Response (202):
```json
{ "replayed": true }
```

Only entries that have not been replayed before can be replayed. A replayed entry is delivered exactly like a normal webhook (with HMAC signing, versioned payload, and retry logic).

### Circuit Breaker

Each subscriber has an associated circuit breaker that protects your endpoint from excessive traffic when it is unhealthy:

| State | Behaviour |
|-------|-----------|
| **CLOSED** | Normal operation. Deliveries proceed. |
| **OPEN** | All deliveries skip directly to dead-letter. No HTTP requests are made. |
| **HALF_OPEN** | One probe request is allowed. Success → CLOSED. Failure → OPEN. |

**Transitions:**
- CLOSED → OPEN: 5 consecutive failures within a 60-second sliding window.
- OPEN → HALF_OPEN: After 30 seconds (configurable).
- HALF_OPEN → CLOSED: Probe succeeds.
- HALF_OPEN → OPEN: Probe fails.

If you are not receiving deliveries, check the dead-letter queue to see if the circuit breaker has tripped.

---

## Test-Ping Endpoint

Use the test-ping endpoint to verify your integration **before** real events start flowing:

```http
POST /api/webhooks/{subscriberId}/test
Authorization: Bearer <token>
```

### Response

```json
{
  "delivered": true,
  "statusCode": 200,
  "latencyMs": 142,
  "signatureHeader": "sha256=<hex-digest>"
}
```

| Field | Description |
|-------|-------------|
| `delivered` | `true` if your endpoint returned 2xx |
| `statusCode` | HTTP status your endpoint returned |
| `latencyMs` | Round-trip time in milliseconds |
| `signatureHeader` | The `x-disciplr-signature` value that was sent — use this to confirm your HMAC verification code |

### Synthetic Payload

The test event uses the **same versioned envelope** as real deliveries, so a passing test guarantees real deliveries will also verify. The event type is `webhook.test`:

```json
{
  "eventId": "test:<uuid>",
  "eventType": "webhook.test",
  "timestamp": "2026-06-28T00:00:00.000Z",
  "data": { "message": "This is a test delivery from Disciplr..." },
  "organizationId": "<your-org-id>",
  "schema_version": 1
}
```

### Rate Limiting

5 requests per subscriber per 60 seconds.

### Error Cases

| Status | Condition |
|--------|-----------|
| 401 | Missing or invalid Bearer token |
| 403 | Subscriber belongs to a different organization |
| 404 | Subscriber not found |
| 422 | Subscriber URL blocked by SSRF guard |
| 429 | Rate limit exceeded |
| 200 + `delivered: false` | URL returned error, timed out, or redirect refused |

---

## Field Masking and PII Stripping

Your subscriber can be configured with a **field policy** that controls which fields appear in delivered payloads and whether PII is masked.

### Policy Modes

| Mode | Behaviour |
|------|-----------|
| **default** | All fields included; PII stripped by default |
| **allowlist** | Only listed fields included |
| **denylist** | All fields except listed ones included |

PII fields (when `stripPii: true`) are replaced with a deterministic 8-character hex hash of the original value. Affected fields include: `creator`, `email`, `userId`, `successDestination`, `failureDestination`, and others — plus email addresses and Stellar account IDs found anywhere in string values.

**Crucially, the HMAC signature is computed after field masking.** Your signature verification will succeed on the payload exactly as you receive it, regardless of the masking policy.

---

## Troubleshooting

| Symptom | Likely Cause | Action |
|---------|-------------|--------|
| Signature verification fails | Wrong secret or body re-serialized | Compare byte-for-byte; use test-ping to confirm |
| No deliveries received | Circuit breaker OPEN or subscriber inactive | Check dead-letter queue; check subscriber status |
| `401` on test-ping | Missing/invalid JWT | Ensure Bearer token is provided |
| `403` on test-ping | Subscriber belongs to different org | Verify `organizationId` matches caller's org |
| Events arriving duplicated | No idempotency check | Implement deduplication by `x-disciplr-event-id` |
| Test ping returns `delivered: false` | Endpoint unreachable or returns error | Check server logs; verify URL is accessible |

---

## Appendix: Quick Reference

### Delivery Headers

| Header | Example |
|--------|---------|
| `x-disciplr-signature` | `sha256=e99a18c428cb38d5f260853678922e03` |
| `x-disciplr-event` | `vault_created` |
| `x-disciplr-event-id` | `a1b2c3d4e5f6...:0` |
| `x-disciplr-delivery-timestamp` | `2026-06-28T12:00:00.000Z` |

### Supported Schema Versions

`1`, `2` — Latest: `2`, Default: `1`

### Supported Event Types

`vault_created`, `vault_completed`, `vault_failed`, `vault_cancelled`, `milestone_created`, `milestone_validated`, `settlement_summary`

### Retry Configuration

| Parameter | Value |
|-----------|-------|
| Max attempts | 3 |
| Initial backoff | 1,000 ms |
| Max backoff | 30,000 ms |
| Multiplier | 2 |
| Jitter | ±25% |
| Request timeout | 10,000 ms |

### Circuit Breaker Defaults

| Parameter | Value |
|-----------|-------|
| Failure threshold | 5 |
| Window | 60,000 ms |
| Half-open timeout | 30,000 ms |

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/admin/webhooks/subscribers` | Create or update subscriber |
| `GET` | `/api/admin/webhooks/subscribers?organization_id=<org>` | List subscribers |
| `POST` | `/api/admin/webhooks/subscribers/:id/rotate-secret` | Rotate signing secret |
| `PATCH` | `/api/admin/webhooks/subscribers/:id/field-policy` | Update field masking policy |
| `GET` | `/api/admin/webhooks/dead-letters` | List dead letters |
| `POST` | `/api/admin/webhooks/dead-letters/:id/replay` | Replay dead letter |
| `POST` | `/api/webhooks/:id/test` | Send test ping |

# Runbook: Replaying Webhook Dead Letters

**Severity:** P2 (P1 if webhook backlog or breaker trips affect critical customer integrations)  
**Owner:** On-call backend engineer  
**Related docs:** [Webhooks Architecture](../webhooks.md) · [Operations Guide](../operations.md) · [Horizon Listener Stall](./horizon-stall.md) · [Background Job Dead Letters](./jobs-dead-letters.md)

---

## Summary

Outbound webhooks notify external tenant subscribers of critical lifecycle events (e.g. `vault_created`, `milestone_completed`, `stake_deposited`). When an outbound delivery permanently fails after exhausting retry backoff attempts or is short-circuited due to an open circuit breaker, the failed delivery payload is moved to the `webhook_dead_letters` table.

This runbook guides operators through diagnosing webhook delivery failures, managing global pause/resume controls, inspecting subscriber circuit breakers and delivery statistics, and replaying dead letters either individually or across a specified time window using the admin Webhooks API.

---

## 1. Symptoms & Detection Signals

All `/api/admin/webhooks/*` endpoints require authentication (`Authorization: Bearer <admin-token>`) and the `ADMIN` role.

### 1.1 Dead letters listing endpoint

Inspect accumulated dead letters:

```bash
curl -s https://api.example.com/api/admin/webhooks/dead-letters \
  -H "Authorization: Bearer <admin-token>" | jq '{count, total, limit, offset, has_more}'
```

Query parameters:
- `limit` (default: `50`, max: `100`)
- `offset` (default: `0`)
- `subscriber_id` (filter dead letters for a specific subscriber)

Key fields in response:
| Field | Meaning |
|---|---|
| `count` | Number of dead-letter records in current page |
| `total` | Total number of dead-letter records matching filter |
| `has_more` | Boolean indicating if additional pages remain |
| `webhook_dead_letters` | Array of dead letter records (`id`, `subscriber_id`, `event_id`, `event_type`, `payload`, `last_error`, `attempts`, `failed_at`, `replayed_at`) |

### 1.2 Delivery pause status

Check if outbound deliveries are currently paused globally:

```bash
curl -s https://api.example.com/api/admin/webhooks/pause/status \
  -H "Authorization: Bearer <admin-token>" | jq .paused
```

| Field | Meaning |
|---|---|
| `paused: true` | Delivery worker is halted; deliveries accumulate in outbox |
| `paused: false` | Normal operation; outbound deliveries active |

### 1.3 Subscriber statistics & circuit breaker status

Check 24-hour delivery analytics and circuit breaker state for an affected subscriber:

```bash
curl -s "https://api.example.com/api/admin/webhooks/<subscriber-id>/stats?window=24h" \
  -H "Authorization: Bearer <admin-token>" \
  | jq '{subscriber_id, breaker_state, attempt_count, success_count, failure_count, success_rate, last_failure_reason}'
```

Key fields:
| Field | Signal |
|---|---|
| `breaker_state` | `"CLOSED"` (healthy), `"OPEN"` (tripped, short-circuiting), `"HALF_OPEN"` (probing) |
| `success_rate` | Ratio of successful deliveries (< 0.90 indicates severe degradation) |
| `last_failure_reason` | Diagnostic error string from last failed attempt |

### 1.4 Database tables & queries

Connect to the PostgreSQL database to inspect raw state:

```sql
-- 1. Count unreplayed dead letters
SELECT COUNT(*) AS unreplayed_dead_letters
FROM webhook_dead_letters
WHERE replayed_at IS NULL;

-- 2. Breakdown by subscriber and event type
SELECT subscriber_id, event_type, COUNT(*) AS count, MAX(failed_at) AS latest_failure
FROM webhook_dead_letters
WHERE replayed_at IS NULL
GROUP BY subscriber_id, event_type
ORDER BY count DESC;

-- 3. Inspect recent dead letter errors
SELECT id, subscriber_id, event_type, attempts, last_error, failed_at
FROM webhook_dead_letters
WHERE replayed_at IS NULL
ORDER BY failed_at DESC
LIMIT 20;

-- 4. Check active circuit breakers
SELECT subscriber_id, state, failure_count, last_failure_at
FROM webhook_breaker_states
WHERE state != 'CLOSED';

-- 5. Review recent delivery attempts for a subscriber
SELECT event_id, event_type, status_code, success, latency_ms, error, attempted_at
FROM webhook_delivery_attempts
WHERE subscriber_id = '<subscriber-id>'
ORDER BY attempted_at DESC
LIMIT 25;
```

---

## 2. Triage

Work through each step to isolate why deliveries are failing before initiating replays.

### 2.1 Is delivery paused globally?

Run the check from §1.2:
```bash
curl -s https://api.example.com/api/admin/webhooks/pause/status \
  -H "Authorization: Bearer <admin-token>"
```
If `paused: true` and no maintenance is ongoing, unpause using §3.1.

### 2.2 Is the subscriber URL reachable and allowed?

Inspect `last_error` in dead letters. Common patterns:
- `ECONNREFUSED` / `ETIMEDOUT`: Subscriber server is offline or network partition.
- `401 Unauthorized` / `403 Forbidden`: Subscriber secret was rotated or invalid header configuration.
- `Egress destination not permitted`: Target hostname/IP failed SSRF check or was removed from `org_webhook_egress_allowlist`.

Verify egress allowlist for the subscriber's organization:
```bash
curl -s "https://api.example.com/api/admin/webhooks/egress-allowlist?organization_id=<organization-id>" \
  -H "Authorization: Bearer <admin-token>" | jq .egress_allowlist
```

### 2.3 Is the subscriber's circuit breaker tripped?

If `breaker_state` is `"OPEN"`, deliveries are immediately dead-lettered without HTTP execution.
Confirm with the subscriber's team that their endpoint is operational again. A successful probe in `HALF_OPEN` state will automatically reset the breaker to `CLOSED`.

---

## 3. Remediation & Recovery Procedures

### 3.1 Unpause delivery

If deliveries were paused, resume outbound processing:

```bash
curl -s -X POST https://api.example.com/api/admin/webhooks/resume \
  -H "Authorization: Bearer <admin-token>" | jq .
```
Expected response:
```json
{
  "paused": false
}
```
Audit action logged: `webhook.delivery.resumed`.

---

### 3.2 Replay a single dead letter

Use this for targeted recovery after an isolated customer failure:

```bash
curl -s -X POST "https://api.example.com/api/admin/webhooks/dead-letters/<dead-letter-id>/replay" \
  -H "Authorization: Bearer <admin-token>" | jq .
```

Expected response (HTTP 202 Accepted):
```json
{
  "replayed": true
}
```

If the subscriber URL is disallowed or the dead letter has already been replayed:
```json
{
  "error": "Dead letter not found or already replayed"
}
```
Audit action logged: `webhook.deadletter.replay`.

---

### 3.3 Replay dead letters in a time window (Bulk Replay)

When a subscriber endpoint was down for an extended maintenance window, replay all missed events in bulk:

```bash
curl -s -X POST "https://api.example.com/api/admin/webhooks/<subscriber-id>/replay" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "start_time": "2026-11-22T00:00:00.000Z",
    "end_time": "2026-11-23T00:00:00.000Z",
    "replay_marker": "incident-recovery-20261123-01",
    "max_events": 500
  }' | jq .
```

Expected response (HTTP 200 OK):
```json
{
  "replayed": true,
  "count": 42,
  "success_count": 42,
  "failure_count": 0,
  "replay_marker": "incident-recovery-20261123-01"
}
```

Key options:
- `start_time` / `end_time` (Required ISO 8601 strings): Bounds the failure timestamp window.
- `replay_marker` (Optional): Idempotency key. Repeating requests with the same marker returns the previous execution results without re-dispatching.
- `max_events` (Optional, default `500`): Rate-bounds replay batch size to avoid overwhelming downstream receiver.

Audit action logged: `webhook.window_replay`.

---

### 3.4 Temporarily pause outbound deliveries

If an incident or downstream cascade requires halting all webhook traffic:

```bash
curl -s -X POST https://api.example.com/api/admin/webhooks/pause \
  -H "Authorization: Bearer <admin-token>" | jq .
```
Expected response:
```json
{
  "paused": true
}
```
Audit action logged: `webhook.delivery.paused`.

---

## 4. Rollback

If a bulk replay causes unexpected errors, downstream degradation, or load spikes on the subscriber:

1. **Pause delivery immediately**:
   ```bash
   curl -s -X POST https://api.example.com/api/admin/webhooks/pause \
     -H "Authorization: Bearer <admin-token>"
   ```
2. **Review delivery attempt errors**:
   ```sql
   SELECT event_id, status_code, error, attempted_at
   FROM webhook_delivery_attempts
   WHERE subscriber_id = '<subscriber-id>'
   ORDER BY attempted_at DESC LIMIT 20;
   ```
3. Since `replayed_at` in `webhook_dead_letters` is only stamped on confirmed delivery success, failed events remain un-stamped and can be safely re-attempted once subscriber health is restored.

---

## 5. Escalation

| Level | Condition | Contact |
|---|---|---|
| Tier 1 | On-call engineer triage, individual dead-letter replays | Primary on-call rotation |
| Tier 2 | Persistent circuit breaker trip (> 2 hours), dead-letter backlog > 1,000 | Platform Engineering Lead |
| Tier 3 | Security / SSRF rejection on legitimate customer domain | Security Operations team |

---

## 6. Post-Incident Checklist

- [ ] Verify `replayed_at IS NOT NULL` for all addressed dead letters in `webhook_dead_letters`.
- [ ] Verify subscriber circuit breaker state returned to `"CLOSED"` in `GET /api/admin/webhooks/:id/stats`.
- [ ] Confirm outbound delivery pause is cleared (`paused: false`).
- [ ] Confirm audit log entries exist for `webhook.deadletter.replay` or `webhook.window_replay`.
- [ ] Update incident ticket with root cause, affected subscriber count, and total replayed events.

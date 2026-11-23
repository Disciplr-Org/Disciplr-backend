# Runbook: Horizon Listener Stall

**Severity:** P1  
**Owner:** On-call engineer  
**Related docs:** [Horizon Listener Architecture](../horizon-listener.md) · [Operations Guide](../operations.md) · [Deadline→Slash Flow](../deadline-slash-flow.md)

---

## Summary

The Horizon listener has stopped advancing its cursor. `deadline.check` jobs that
drive `slash_on_miss` submissions cannot run against the correct chain state, and a
backlog of expired vaults is building up in the `vaults` table. This runbook takes
you from first alert through full recovery.

---

## 1. Detection Signals

### 1.1 Deep-health endpoint

```bash
curl -s https://api.example.com/api/health/deep \
  -H "Authorization: Bearer <admin-token>" | jq .details.horizonListener
```

A stalled listener returns one of:

| `status` | Meaning |
|---|---|
| `"stale"` | No event processed for > 5 min (`LISTENER_DEGRADED_THRESHOLD_MS`) |
| `"down"` | No event processed for > 30 min (`LISTENER_DOWN_THRESHOLD_MS`) |

Key fields to capture:

- `timeSinceLastEventMs` — elapsed ms since last event
- `lastProcessedLedger` — last ledger written to `listener_state`
- `lastProcessedAt` — ISO timestamp of that write

### 1.2 Lag gauge

```bash
curl -s https://api.example.com/api/admin/horizon/listener \
  -H "Authorization: Bearer <admin-token>" | jq '{lag, heartbeatAgeMs, lastProcessedLedger, lastError}'
```

Key fields:

| Field | Stall signal |
|---|---|
| `lag` | Growing or exceeds `HORIZON_LAG_THRESHOLD` (default 10) |
| `heartbeatAgeMs` | > 300 000 ms (5 min) is degraded; > 1 800 000 ms (30 min) is down |
| `lastProcessedLedger` | Frozen across successive polls |
| `lastError` | Non-null — check `message` and `retryCount` |

### 1.3 DB tables

```sql
-- Heartbeat age
SELECT service_name, last_processed_ledger, last_processed_at,
       EXTRACT(EPOCH FROM (now() - last_processed_at)) AS stale_seconds
FROM listener_state
WHERE service_name = 'horizon_listener';

-- Cursor position
SELECT contract_address, last_ledger, last_paging_token, updated_at
FROM horizon_checkpoints;

-- Latest committed event ledger
SELECT MAX(ledger_number) AS latest_committed FROM processed_events;

-- Slash backlog (expired vaults not yet failed)
SELECT COUNT(*) AS backlog
FROM vaults
WHERE status = 'active' AND end_date <= now();
```

---

## 2. Triage

Work through each question in order; stop when you find the cause.

### 2.1 Is the process alive?

```bash
# systemd
systemctl status disciplr-horizon-listener

# Kubernetes
kubectl get pods -l app=disciplr-horizon-listener
kubectl logs -l app=disciplr-horizon-listener --tail=100
```

If the process is dead → **go to §3.1 (simple restart)**.

### 2.2 Is the listener connected to Horizon?

Look for repeated `horizon.connection_error` or `horizon.stream_error` events in
the structured logs:

```bash
journalctl -u disciplr-horizon-listener --since "30 min ago" \
  | grep -E '"event":"horizon\.(connection_error|stream_error)"'
```

If connection errors are present:

- Verify `HORIZON_URL` reachability: `curl -I "$HORIZON_URL/ledgers?order=desc&limit=1"`
- Check Stellar network status at [status.stellar.org](https://status.stellar.org)
- If Horizon is down, **wait for upstream recovery** — no cursor reset required.

### 2.3 Is the cursor stuck at an unprocessable event?

Check `lastError` from the listener status endpoint (§1.2) and look for
`horizon.event_processing_failed` or `horizon.event_parse_failed` in logs with a
high `retryCount`.

If a single bad event is blocking the cursor → **go to §3.3 (cursor advance past bad event)**.

### 2.4 Is the database connection healthy?

```bash
curl -s https://api.example.com/api/health/deep \
  -H "Authorization: Bearer <admin-token>" | jq .details.database
```

A `"down"` database blocks checkpoint writes even when event processing succeeds.
Fix the DB connectivity before any cursor operation.

### 2.5 Are there pending slash backlog vaults?

```sql
SELECT id, end_date, status
FROM vaults
WHERE status = 'active' AND end_date <= now()
ORDER BY end_date
LIMIT 20;
```

If rows are returned, the expiration scheduler may also be stalled. Check:

```bash
curl -s https://api.example.com/api/health/deep \
  -H "Authorization: Bearer <admin-token>" | jq .details.expirationScheduler
```

Note the backlog count — you will drain it in §4.

---

## 3. Recovery Procedures

### 3.1 Simple restart (process dead or transient connection failure)

```bash
systemctl restart disciplr-horizon-listener
# or
kubectl rollout restart deployment/disciplr-horizon-listener
```

Wait 60 s and re-poll the deep-health endpoint. The listener reads stored
`horizon_checkpoints` automatically — no cursor reset is needed.

**Verify:** `status` returns `"up"` and `lastProcessedLedger` is advancing.

---

### 3.2 Cursor reset (checkpoint too far ahead or corrupted)

Use this when the checkpoint ledger is ahead of reality (e.g. a bad deploy
advanced it without actually persisting event data).

**Step 1 — Stop the listener** to prevent concurrent writes:

```bash
systemctl stop disciplr-horizon-listener
```

**Step 2 — Identify the safe rollback ledger:**

```sql
-- Highest ledger for which we have committed event data
SELECT MAX(ledger_number) AS safe_ledger FROM processed_events;
```

Choose a ledger at or before `safe_ledger`. Round down to the nearest known-good
boundary if you are unsure.

**Step 3 — Inspect the current checkpoint:**

```bash
curl -s https://api.example.com/api/admin/horizon/listener \
  -H "Authorization: Bearer <admin-token>" \
  | jq '.data.cursor'
```

**Step 4 — Reset the cursor:**

```bash
# Without force (target ledger >= latestProcessedLedger — safe)
curl -X POST https://api.example.com/api/admin/horizon/listener/reset-cursor \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "contractAddress": "<CONTRACT_ADDRESS>",
    "ledger": <SAFE_LEDGER>,
    "pagingToken": "<SAFE_LEDGER>-0",
    "reason": "rewind after stall incident"
  }'

# With force (target ledger < latestProcessedLedger — replays already-committed events)
curl -X POST https://api.example.com/api/admin/horizon/listener/reset-cursor \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "contractAddress": "<CONTRACT_ADDRESS>",
    "ledger": <SAFE_LEDGER>,
    "pagingToken": "<SAFE_LEDGER>-0",
    "reason": "rewind behind processed events — incident recovery",
    "force": true
  }'
```

The API returns `409` if `ledger < latestProcessedLedger` and `force` is omitted.

**Step 5 — Restart the listener:**

```bash
systemctl start disciplr-horizon-listener
```

Replay of already-committed events is safe: the `processed_events` idempotency
table skips duplicates without producing side-effects.

**Verify:** Poll the listener status until `lastProcessedLedger` advances past the
reset ledger.

---

### 3.3 Cursor advance past a bad event

If a single malformed event is poison-pilling the cursor:

1. Record the stuck ledger from `lastError.eventId` / `lastProcessedLedger + 1`.
2. Follow §3.2 but set `ledger` to the stuck ledger + 1 (skipping the bad event).
3. Add the `eventId` to the `processed_events` table manually to prevent re-delivery:

```sql
INSERT INTO processed_events (event_id, ledger_number, processed_at)
VALUES ('<BAD_EVENT_ID>', <STUCK_LEDGER>, now())
ON CONFLICT (event_id) DO NOTHING;
```

4. Restart and verify.
5. File a bug with the raw event payload for the parse failure.

---

## 4. Drain the Slash Backlog

After the listener is healthy, drain any vaults that expired during the stall.

### 4.1 Check the backlog size

```sql
SELECT COUNT(*) AS backlog
FROM vaults
WHERE status = 'active' AND end_date <= now();
```

### 4.2 The expiration scheduler drains automatically

`startExpirationChecker` runs every 60 s (default) and calls
`processExpiredVaultsBatch` → `enqueueSlashJobs`. If the scheduler is healthy
(`expirationScheduler.status = "up"` in deep-health), it will drain the backlog
within a few scheduler ticks without manual intervention.

Monitor drain progress:

```bash
# Watch the backlog shrink
watch -n 15 "psql \$DATABASE_URL -c \
  \"SELECT COUNT(*) FROM vaults WHERE status='active' AND end_date <= now();\""
```

### 4.3 Double-slash prevention

Each vault ID is protected by an in-memory idempotency key
`slash_on_miss:<vaultId>`. Even if the scheduler runs multiple times, a vault is
enqueued **at most once per process lifetime**. The Soroban contract's `NotActive`
guard prevents on-chain double-slash even if the job is somehow enqueued twice.

> **Note:** The in-memory idempotency store resets on process restart. If the
> service restarts mid-drain, already-enqueued vaults will be re-enqueued once.
> The contract guard is the definitive safety net.

### 4.4 Dry-run verification (optional)

Set `DRY_RUN=true` to observe expiration detection without touching the queue:

```bash
DRY_RUN=true systemctl start disciplr-horizon-listener
# Watch for: [ExpirationChecker] DRY_RUN: skipping enqueue for vault <id>
journalctl -u disciplr-horizon-listener -f | grep DRY_RUN
```

---

## 5. Verification Checklist

Run all checks before closing the incident.

- [ ] `GET /api/health/deep` → `details.horizonListener.status = "up"`
- [ ] `GET /api/admin/horizon/listener` → `lag` ≤ `HORIZON_LAG_THRESHOLD` (default 10) and `heartbeatAgeMs` < 60 000
- [ ] `lastProcessedLedger` in listener status is advancing across two polls 60 s apart
- [ ] `SELECT MAX(ledger_number) FROM processed_events` increasing
- [ ] `SELECT COUNT(*) FROM vaults WHERE status='active' AND end_date <= now()` = 0 (or decreasing to 0)
- [ ] `GET /api/health/deep` → `details.expirationScheduler.status = "up"`
- [ ] No `horizon.connection_error` or `horizon.event_processing_failed` in recent logs
- [ ] Audit log entry for cursor reset present if §3.2 was used:

```bash
curl -s "https://api.example.com/api/admin/audit-logs?page=1&pageSize=5" \
  -H "Authorization: Bearer <admin-token>" \
  | jq '[.data[] | select(.action == "horizon.listener.cursor_reset")]'
```

---

## 6. Rollback / Abort Path

If the cursor reset makes things worse (e.g. replay triggers unexpected side-effects):

1. **Stop the listener immediately:**
   ```bash
   systemctl stop disciplr-horizon-listener
   ```

2. **Restore the previous checkpoint** using the `previousCheckpoint` values
   returned in the reset-cursor response body, with `force=true`:
   ```bash
   curl -X POST https://api.example.com/api/admin/horizon/listener/reset-cursor \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d '{
       "contractAddress": "<CONTRACT_ADDRESS>",
       "ledger": <PREVIOUS_LEDGER>,
       "pagingToken": "<PREVIOUS_PAGING_TOKEN>",
       "reason": "rollback of incident recovery cursor reset",
       "force": true
     }'
   ```

3. **Escalate** — do not restart the listener until the root cause is understood.

4. All cursor reset operations are logged to `audit_logs` with action
   `horizon.listener.cursor_reset` and include `previous_ledger`,
   `requested_ledger`, `force`, and `latest_processed_ledger` for forensics.

---

## 7. Environment Variables Reference

| Variable | Default | Effect on stall response |
|---|---|---|
| `HORIZON_URL` | — | Horizon endpoint; verify reachability in §2.2 |
| `CONTRACT_ADDRESS` | — | Target contract(s); required for reset-cursor |
| `HORIZON_LAG_THRESHOLD` | `10` | Lag ledger count that triggers a warning log |
| `LISTENER_DEGRADED_THRESHOLD_MS` | `300000` | Age (ms) at which deep-health returns `"stale"` |
| `LISTENER_DOWN_THRESHOLD_MS` | `1800000` | Age (ms) at which deep-health returns `"down"` |
| `HORIZON_SHUTDOWN_TIMEOUT_MS` | `30000` | In-flight event drain grace period on stop |
| `DRY_RUN` | `false` | Skip slash enqueue (safe observation mode) |

---

## 8. Admin Endpoints Quick Reference

| Endpoint | Purpose |
|---|---|
| `GET /api/health/deep` | System-wide health including `horizonListener` and `expirationScheduler` |
| `GET /api/admin/horizon/listener` | Cursor position, lag, heartbeat age, last error |
| `POST /api/admin/horizon/listener/reset-cursor` | Move the checkpoint to a specific ledger |
| `GET /api/admin/audit-logs` | Audit trail including cursor reset history |

All `/api/admin/*` endpoints require `Authorization: Bearer <admin-token>`.

---

## 9. DB Tables Reference

| Table | Relevance |
|---|---|
| `listener_state` | `last_processed_ledger`, `last_processed_at` — heartbeat source |
| `horizon_checkpoints` | Per-contract cursor (`last_ledger`, `last_paging_token`) |
| `processed_events` | Idempotency store; `MAX(ledger_number)` = highest committed ledger |
| `vaults` | `status='active' AND end_date <= now()` = slash backlog |
| `scheduler_heartbeats` | Expiration scheduler liveness (`name='expiration_scheduler'`) |
| `audit_logs` | Cursor reset history (`action='horizon.listener.cursor_reset'`) |

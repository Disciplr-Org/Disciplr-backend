# Horizon Listener — Operations Guide

## Overview

The Horizon Listener is a long-running service that connects to the Stellar Horizon API, streams Soroban contract events for the configured contract addresses, and writes them into the application database. This listener is a key component of the event processing pipeline (see [Event Processing Guide](event-processing.md) for context on how these events are subsequently handled).

Key properties:

| Property | Value |
|---|---|
| Delivery guarantee | **At-least-once** |
| Duplicate defence | `processed_events` idempotency table |
| Cursor storage | `horizon_checkpoints` table (per-contract) |
| Admin tooling | `GET /api/admin/horizon/listener`, `POST /api/admin/horizon/listener/reset-cursor` |

---

## Architecture

```
Horizon SSE stream
       │
       ▼
HorizonListener.handleEvent(rawEvent)
       │  filter by contractId
       │  parse XDR → ParsedEvent
       ▼
EventProcessor.processEvent(event)
       │  BEGIN TRANSACTION
       │    check processed_events (idempotency)
       │    execute business logic (vaults / milestones / validations)
       │    INSERT processed_events
       │  COMMIT
       ▼
CheckpointStore.upsertCheckpoint(contractId, ledger, pagingToken)
       │  INSERT … ON CONFLICT DO UPDATE
       ▼
  horizon_checkpoints row updated
```

### At-least-once guarantee

If the process crashes between the event transaction commit and the checkpoint write, the event is re-delivered on the next start.  The `processed_events` idempotency table ensures the re-delivered event is skipped without duplicate side-effects.

### Multi-contract streaming

Each contract address maintains an independent checkpoint.  On startup the listener loads every contract's stored ledger and begins the Horizon stream from the **minimum** across all contracts.  This ensures no contract falls behind: events for ahead contracts are replayed but safely no-op'd by the idempotency check.

---

## Database Schema

### `horizon_checkpoints`

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` | Auto-increment PK |
| `contract_address` | `varchar(128)` | Unique — one row per contract |
| `last_ledger` | `bigint` | Last confirmed ledger sequence |
| `last_paging_token` | `varchar(256)` | Horizon SSE cursor (nullable for seed rows) |
| `updated_at` | `timestamptz` | Set on every upsert |
| `created_at` | `timestamptz` | Set on first insert |

Migration file: `db/migrations/20260427000000_create_horizon_checkpoints.cjs`

---

## Configuration

All settings are validated at startup by `src/config/env.ts` (fail-fast with structured error messages).

| Variable | Required | Default | Description |
|---|---|---|---|
| `HORIZON_URL` | Yes | — | Stellar Horizon HTTP(S) endpoint |
| `CONTRACT_ADDRESS` | Yes | — | Comma-separated Soroban contract addresses |
| `START_LEDGER` | No | `0` | Ledger to start from when no checkpoint exists |
| `RETRY_MAX_ATTEMPTS` | No | `3` | Max retries for transient connection errors |
| `RETRY_BACKOFF_MS` | No | `100` | Initial exponential-backoff delay (ms) |
| `HORIZON_SHUTDOWN_TIMEOUT_MS` | No | `30000` | Grace period for in-flight events on shutdown |
| `HORIZON_LAG_THRESHOLD` | No | `10` | Ledger lag count before an alert is emitted |

---

## Running the Service

```bash
# From the project root
node dist/services/horizonListenerMain.js
```

Or via `tsx` in development:

```bash
tsx src/services/horizonListenerMain.ts
```

Structured JSON logs are written to stdout.  All fatal errors exit with code `1`.

---

## Admin Listener Endpoints

All endpoints require an authenticated admin session (`Authorization: Bearer <token>`).  They are mounted under `/api/admin` which applies `authenticate` + `requireAdmin` middleware, preserving the 401-before-403 invariant.

### Inspect listener status

```
GET /api/admin/horizon/listener
```

Response `200`:
```json
{
  "data": {
    "cursor": {
      "effectiveLedger": 50000,
      "checkpoints": [
        {
          "contractAddress": "CDISCIPLR...",
          "lastLedger": 50000,
          "lastPagingToken": "50000-0",
          "updatedAt": "2026-04-27T12:00:00.000Z",
          "createdAt": "2026-04-01T00:00:00.000Z"
        }
      ]
    },
    "lastProcessedLedger": 50000,
    "latestProcessedLedger": 50000,
    "lag": 3,
    "heartbeatAgeMs": 12000,
    "lastProcessedAt": "2026-04-27T12:00:00.000Z",
    "listenerStateUpdatedAt": "2026-04-27T12:00:00.000Z",
    "lastError": {
      "eventId": "evt-123",
      "message": "temporary parse failure",
      "retryCount": 1,
      "failedAt": "2026-04-27T12:01:00.000Z"
    }
  }
}
```

`cursor.effectiveLedger` is the minimum stored checkpoint ledger across configured contracts, which is the ledger the listener uses as the safe resume floor. `lag` is the most recent in-process monitor measurement and may be `null` until the monitor has run.

### Reset the listener cursor

```
POST /api/admin/horizon/listener/reset-cursor
Content-Type: application/json

{
  "contractAddress": "CDISCIPLR...",
  "ledger": 45000,
  "pagingToken": "45000-0",
  "reason": "rewind after bad checkpoint",
  "force": false
}
```

- `contractAddress` (string, optional only when exactly one contract can be inferred) - target contract checkpoint.
- `ledger` (integer >= 0, required) - target ledger.
- `pagingToken` (string, optional) - Horizon paging token for the ledger.
- `reason` (string, optional) - audit context. Obvious secrets and PII are redacted.
- `force` (boolean, optional) - required to reset behind already processed events.

Response `200`:
```json
{
  "message": "Horizon listener cursor reset",
  "checkpoint": {
    "contractAddress": "CDISCIPLR...",
    "lastLedger": 45000,
    "lastPagingToken": "45000-0",
    "updatedAt": "2026-04-27T12:05:00.000Z",
    "createdAt": "2026-04-01T00:00:00.000Z"
  },
  "previousCheckpoint": {
    "contractAddress": "CDISCIPLR...",
    "lastLedger": 50000,
    "lastPagingToken": "50000-0",
    "updatedAt": "2026-04-27T12:00:00.000Z",
    "createdAt": "2026-04-01T00:00:00.000Z"
  },
  "latestProcessedLedger": 50000,
  "forced": true,
  "auditLogId": "audit-123"
}
```

If `ledger` is lower than the highest `processed_events.ledger_number`, the API returns `409` unless `force=true`. This guard prevents accidental replay behind already-committed events while still giving operators an audited break-glass path for incident recovery.

---

## Operational Recovery Steps

### Scenario 1 — Service crash, normal restart

The listener stores a checkpoint after every successfully processed event.  Simply restart the process:

```bash
systemctl restart disciplr-horizon-listener
```

The service reads the stored checkpoints and resumes automatically.

---

### Scenario 2 — Missed events (checkpoint too far ahead)

If a bug caused the checkpoint to advance without actually persisting business data, you must rewind to the last known-good ledger.

**Steps:**

1. **Stop the listener** to prevent concurrent writes.
2. Identify the last reliable ledger (check `processed_events.ledger_number` or Stellar explorer).
3. Inspect the current listener state:
   ```bash
   curl https://api.example.com/api/admin/horizon/listener \
     -H "Authorization: Bearer <admin-token>"
   ```
4. Reset the cursor. Use `force=true` only when the target ledger is intentionally behind already processed events:
   ```bash
   curl -X POST https://api.example.com/api/admin/horizon/listener/reset-cursor \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d '{"contractAddress":"CDISCIPLR...","ledger":49000,"pagingToken":"49000-0","reason":"rewind after bad checkpoint","force":true}'
   ```
5. Restart the listener — events from ledger 49 000 are replayed; already-processed events are skipped by the idempotency check.

---

### Scenario 3 — Add a new contract address

1. Add the address to `CONTRACT_ADDRESS` (comma-separated).
2. No checkpoint exists for the new address, so `START_LEDGER` is used as the starting point.
3. Restart the listener.

To start a new contract from a specific ledger rather than `START_LEDGER`, seed a checkpoint before restarting:

```bash
curl -X POST https://api.example.com/api/admin/horizon/listener/reset-cursor \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"contractAddress":"CNEWCONTRACT","ledger":999000}'
```

---

### Scenario 4 — Remove a contract address

1. Remove the address from `CONTRACT_ADDRESS`.
2. (Optional) leave the checkpoint row in place for auditability, or remove it with a controlled database maintenance task.
3. Restart the listener.

---

### Scenario 5 — Full re-index

Delete all checkpoints and truncate the business tables, then restart from `START_LEDGER`.

```sql
TRUNCATE horizon_checkpoints, processed_events, vaults, milestones, validations CASCADE;
```

```bash
systemctl restart disciplr-horizon-listener
```

⚠️ This is destructive.  Run in a maintenance window.

---

## Cursor Persistence Semantics

### Boot — resume from last checkpoint

On startup `HorizonListener.loadEffectiveStartLedger()` queries `CheckpointStore.getCheckpoint(contractAddress)` for **every** contract in `CONTRACT_ADDRESS`.  The Horizon stream is opened from the **minimum** confirmed ledger across all contracts:

```
effectiveLedger = min(
  checkpoint.lastLedger   // for each contract that has a row
  config.startLedger      // fallback for contracts with no row
)
```

This guarantees that no contract falls behind.  Contracts whose stored ledger is already higher than the stream cursor will receive replayed events, but the `processed_events` idempotency table absorbs those duplicates without side-effects.

### Advance — cursor written only after durable commit

The checkpoint is written **after** `EventProcessor.processEvent()` returns `{ success: true }`, which itself only returns success after the database transaction containing the business logic and the `processed_events` row has been committed.

Sequence per event:

```
1. BEGIN TRANSACTION
2.   INSERT / UPDATE business table  (vault / milestone / validation)
3.   INSERT processed_events         (idempotency record)
4. COMMIT
5. CheckpointStore.upsertCheckpoint(contractId, ledger, pagingToken)
```

If the process crashes between steps 4 and 5, the event is re-delivered on next boot.  Step 2 is skipped on re-delivery (idempotency check), and step 5 succeeds on the second attempt — so the cursor catches up automatically.

### Connection loss — cursor is never reset

When the Horizon SSE connection drops, `HorizonListener` enters a retry loop with exponential backoff (1 s → 2 s → 4 s → … → 60 s cap).  The cursor stored in `horizon_checkpoints` is **not modified** during reconnect attempts.  Once the connection is restored, the stream resumes from the same checkpoint that was last confirmed.

### Filtering — cursor is not advanced for filtered events

Events from contract addresses not listed in `CONTRACT_ADDRESS` are dropped before parsing.  No checkpoint write occurs for filtered events.

### Parse failures — cursor is not advanced

If `EventParser.parseHorizonEvent()` returns `{ success: false }`, the event is logged and skipped.  No checkpoint write occurs.  The stream advances to the next event naturally via the SSE protocol, so the listener does not stall on persistent parse failures.

---

## Incident Response

For step-by-step recovery when the listener stalls and the slash backlog builds
up, see the dedicated runbook:
**[Horizon Listener Stall Runbook](runbooks/horizon-stall.md)**

---

## Security Notes

- Listener status and cursor-reset endpoints are **admin-only**.
- Cursor resets emit audit log entries (`horizon.listener.cursor_reset`) containing before/after cursor details, force status, latest processed ledger, request context, and sanitized operator reason.
- Secrets (`DATABASE_URL`, JWT keys) are never included in structured log output — only field names and validation messages appear.
- RBAC is enforced by `requireAdmin` middleware on the entire `/api/admin` router.

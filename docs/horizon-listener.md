# Horizon Listener — Operations Guide

## Overview

The Horizon Listener is a long-running service that connects to the Stellar Horizon API, streams Soroban contract events for the configured contract addresses, and writes them into the application database. This listener is a key component of the event processing pipeline (see [Event Processing Guide](event-processing.md) for context on how these events are subsequently handled).

Key properties:

| Property | Value |
|---|---|
| Delivery guarantee | **At-least-once** |
| Duplicate defence | `processed_events` idempotency table |
| Cursor storage | `horizon_checkpoints` table (per-contract) |
| Admin tooling | `GET/POST/DELETE /admin/horizon/checkpoints/*` |

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

## Admin Checkpoint Endpoints

All endpoints require an authenticated admin session (`Authorization: Bearer <token>`).  They are mounted under `/admin` which applies `authenticate` + `requireAdmin` middleware.

### List all checkpoints

```
GET /admin/horizon/checkpoints
```

Response `200`:
```json
{
  "checkpoints": [
    {
      "id": 1,
      "contractAddress": "CDISCIPLR…",
      "lastLedger": 50000,
      "lastPagingToken": "50000-0",
      "updatedAt": "2026-04-27T12:00:00.000Z",
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

### Inspect one contract

```
GET /admin/horizon/checkpoints/:contractAddress
```

Returns `404` if no checkpoint exists for that address.

### Reset a checkpoint

```
POST /admin/horizon/checkpoints/:contractAddress/reset
Content-Type: application/json

{
  "ledger": 45000,
  "pagingToken": "45000-0"
}
```

- `ledger` (integer ≥ 0, required) — target ledger
- `pagingToken` (string, optional) — Horizon paging token for the ledger

Response `200`:
```json
{
  "message": "Checkpoint reset",
  "checkpoint": { … }
}
```

### Delete a checkpoint

```
DELETE /admin/horizon/checkpoints/:contractAddress
```

Removes the checkpoint row entirely.  On the next listener start, the contract resumes from `START_LEDGER`.

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
3. Reset the checkpoint:
   ```bash
   curl -X POST https://api.example.com/admin/horizon/checkpoints/CDISCIPLR… \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d '{"ledger": 49000}'
   ```
4. Restart the listener — events from ledger 49 000 are replayed; already-processed events are skipped by the idempotency check.

---

### Scenario 3 — Add a new contract address

1. Add the address to `CONTRACT_ADDRESS` (comma-separated).
2. No checkpoint exists for the new address, so `START_LEDGER` is used as the starting point.
3. Restart the listener.

To start a new contract from a specific ledger rather than `START_LEDGER`, seed a checkpoint before restarting:

```bash
curl -X POST https://api.example.com/admin/horizon/checkpoints/CNEWCONTRACT \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"ledger": 999000}'
```

---

### Scenario 4 — Remove a contract address

1. Remove the address from `CONTRACT_ADDRESS`.
2. (Optional) Delete its checkpoint to avoid table growth:
   ```bash
   curl -X DELETE https://api.example.com/admin/horizon/checkpoints/COLDCONTRACT \
     -H "Authorization: Bearer <admin-token>"
   ```
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

## Security Notes

- Checkpoint reset/delete endpoints are **admin-only** and emit audit log entries (`horizon.checkpoint.reset`, `horizon.checkpoint.deleted`).
- Secrets (`DATABASE_URL`, JWT keys) are never included in structured log output — only field names and validation messages appear.
- RBAC is enforced by `requireAdmin` middleware on the entire `/admin` router.

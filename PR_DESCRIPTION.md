## Summary

Adds bounded pagination and per-row error isolation to the `replayForVault` function, preventing a single replay request from holding an HTTP connection open indefinitely on high-activity vaults.

Closes #1118

## Problem

`replayForVault` in `src/services/outboxRelay.ts` (the admin-triggered vault outbox replay path, invoked from `POST /api/admin/vaults/:id/replay-events`) queried every matching historical outbox row with **no `.limit()` clause**:

```typescript
const rows = await db('vault_outbox')
  .whereRaw("payload->'data'->>'vaultId' = ?", [vaultId])
  .orderBy('created_at', 'asc')  // ← no .limit()
```

For a long-lived, high-activity vault with thousands of historical outbox rows, a single replay request could:
1. Hold the HTTP response open for an unbounded duration
2. Hammer the target webhook endpoint sequentially with no rate limiting or batching
3. Abort the entire batch if any single dispatch threw (the original code had no per-row error handling)

This contrasts with `relayOutboxBatch` in the same file, which processes work in bounded `batchSize` chunks via `SKIP LOCKED` with proper per-row error handling and dead-letter routing.

## Changes

### `src/services/outboxRelay.ts`

- **Added `DEFAULT_REPLAY_BATCH_SIZE`** (200) and **`MAX_REPLAY_BATCH_SIZE`** (500) constants
- **Added `ReplayForVaultResult`** interface returning `{ count, hasMore }` instead of a bare number
- **Refactored `replayForVault`** to accept `limit` and `offset` parameters (with sensible defaults):
  - Uses `limit + 1` query pattern to detect whether more pages exist without a separate `COUNT` query
  - Clamps inputs: `limit` to `[1, 500]`, `offset` to `[0, ∞)`
  - Isolates each dispatch in a `try/catch` so one failing delivery does not abort the remaining events in the batch
  - Logs failures via `console.error` but continues processing
  - Returns `{ count: number, hasMore: boolean }`

### `src/routes/adminWebhooks.ts`

- **Imported `DEFAULT_REPLAY_BATCH_SIZE` and `MAX_REPLAY_BATCH_SIZE`** from `outboxRelay`
- **Updated `POST /:id/replay-events`** handler:
  - Accepts optional `limit` (default 200, max 500) and `offset` (default 0) in the request body
  - Validates `limit` does not exceed `MAX_REPLAY_BATCH_SIZE`
  - Passes pagination params through to `replayForVault`
  - Returns pagination metadata (`count`, `has_more`, `limit`, `offset`) in the response
  - Updated audit log metadata to include pagination context

## Usage

**Request** (with pagination):
```json
POST /api/admin/vaults/:id/replay-events
{
  "subscriber_id": "optional-subscriber-uuid",
  "limit": 200,
  "offset": 0
}
```

**Response**:
```json
{
  "replayed": true,
  "count": 200,
  "has_more": true,
  "limit": 200,
  "offset": 0
}
```

Clients should iterate by incrementing `offset` by `limit` until `has_more` is `false`.

## Testing

- All existing tests continue to pass (`notifications.pagination.test.ts`, `membership.pagination.test.ts`, etc.)
- The `replayForVault` return type changed from `Promise<number>` to `Promise<ReplayForVaultResult>`; the only caller in `adminWebhooks.ts` has been updated accordingly
- Per-row error handling prevents one bad dispatch from aborting the entire batch

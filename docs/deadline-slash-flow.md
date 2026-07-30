# Deadline → Slash-on-Miss Flow

Documents how an expired vault travels from detection in the expiration scheduler all the way to a Soroban `slash_on_miss` payload being constructed in the job handler.

---

## Overview

```
┌──────────────────────────┐
│  ExpirationScheduler     │  (setInterval, every 60 s by default)
│  processExpiredVaultsBatch│
│  → marks vaults 'failed' │
└────────────┬─────────────┘
             │ returns string[] (expired vault IDs)
             ▼
┌──────────────────────────┐
│  enqueueSlashJobs()      │
│  ┌─ DRY_RUN guard ───────┤  DRY_RUN=true → log only, no enqueue
│  ├─ Idempotency check ───┤  getIdempotentResponse('slash_on_miss:<id>', hash)
│  ├─ jobSystem.enqueue ───┤  type='deadline.check', maxAttempts=3
│  └─ saveIdempotentResponse┤  prevents double-enqueue for same vault
└────────────┬─────────────┘
             │ job queued
             ▼
┌──────────────────────────┐
│  BackgroundJobSystem     │  InMemoryJobQueue worker picks up job
│  deadline.check handler  │
└────────────┬─────────────┘
             │ payload.vaultId present?
             ▼
┌──────────────────────────┐
│  buildSlashOnMissPayload │  (soroban.ts)
│  → returns payload object│  mode='submit', status='not_configured'
└──────────────────────────┘
```

---

## Stage-by-Stage Breakdown

### 1. Expiration Detection — `expirationScheduler.ts`

`startExpirationChecker(intervalMs?, jobSystem?)` sets up a recurring timer.  
Each tick calls `processExpiredVaultsBatch()`:

- Queries `vaults` table for rows where `status = 'active'` AND `end_date <= now()`
- Updates matching rows to `status = 'failed'` (one by one, fault-isolated)
- Returns the list of vault IDs that were successfully marked

### 2. Enqueue Trigger — `enqueueSlashJobs()`

For each returned vault ID:

| Condition | Behaviour |
|-----------|-----------|
| `DRY_RUN=true` | Logs a message, skips `enqueue` entirely |
| Idempotency key already exists | Skips `enqueue` (deduplication) |
| Normal | Calls `jobSystem.enqueue('deadline.check', { vaultId, triggerSource: 'expiration-scheduler' }, { maxAttempts: 3 })` then saves idempotency record |

### 3. Idempotency Check — `idempotency.ts`

Uses the in-memory idempotency store (no database):

```
key  = `slash_on_miss:<vaultId>`
hash = vaultId   (deterministic; same vault → same hash)
```

- `getIdempotentResponse(key, hash)` → returns saved response or `null`
- `saveIdempotentResponse(key, hash, vaultId, { enqueued: true })` → records the enqueue

> **Reset between test runs**: call `resetIdempotencyStore()` in `beforeEach`.

### 4. Handler — `handlers.ts` → `deadline.check`

The job handler receives `DeadlineCheckJobPayload`:

```typescript
{
  vaultId?: string           // set by expiration-scheduler
  deadlineIso?: string       // optional
  triggerSource: 'manual' | 'scheduler' | 'expiration-scheduler'
}
```

After logging the deadline check result, it branches:

```typescript
if (payload.vaultId) {
  const sorobanPayload = buildSlashOnMissPayload(payload.vaultId)
  logJob('deadline.check', `slash_on_miss built vault=${payload.vaultId} status=${sorobanPayload.submission.status}`)
}
```

### 5. Soroban Payload Build — `soroban.ts`

`buildSlashOnMissPayload(vaultId)` returns a plain object — **no network call is made**:

```typescript
{
  mode: 'submit',
  payload: {
    contractId:        SOROBAN_CONTRACT_ID    ?? 'CONTRACT_ID_NOT_CONFIGURED',
    networkPassphrase: SOROBAN_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
    sourceAccount:     SOROBAN_SOURCE_ACCOUNT ?? 'SOURCE_ACCOUNT_NOT_CONFIGURED',
    method: 'slash_on_miss',
    args: { vaultId },
  },
  submission: { attempted: true, status: 'not_configured' },
}
```

`status: 'not_configured'` signals that real on-chain submission requires all five `SOROBAN_*` env vars to be set (future work).

### 6. Contract Guardrails — `contracts/accountability_vault`

The Soroban contract tests pin the on-chain deadline and authorization edges that the backend flow depends on:

| Scenario | Expected state / error |
|----------|------------------------|
| Slash before the deadline | `slash_on_miss` returns `DeadlineNotReached`; vault remains `Active` with stake intact |
| Slash exactly at the deadline | `slash_on_miss` returns `DeadlineNotReached`; slashing opens only after `end_timestamp` |
| Slash after a missed deadline | vault transitions `Active → Failed`, `staked` becomes `0`, and funds move to `failure_destination` |
| Double slash | second `slash_on_miss` returns `NotActive`; `Failed` remains terminal |
| Check-in after slash | `check_in` returns `NotActive`; failed vaults cannot be revived by late verification |
| Random caller check-in | returns `Unauthorized` whether the oracle is unset or a different oracle is configured |
| Verifier with oracle configured | verifier check-in still marks the milestone verified; oracle configuration is additive |

These assertions align with `docs/vault-state-machine.md` (`failed` is terminal) and `docs/contract_errors.md` (`DeadlineNotReached`, `NotActive`, and `Unauthorized`).

### 7. Dry-Run Mode

Set `DRY_RUN=true` to observe the detection and idempotency logic without touching the job queue:

```bash
DRY_RUN=true node dist/index.js
```

Log output per skipped vault:
```
[ExpirationChecker] DRY_RUN: skipping enqueue for vault <vaultId>
```

---

## Job System Injection (Testability)

`startExpirationChecker` accepts an optional second parameter:

```typescript
startExpirationChecker(intervalMs?: number, jobSystem?: BackgroundJobSystem): void
```

- **Production** (`index.ts`): called without `jobSystem`, uses an internal lazy singleton
- **Tests**: pass a mock `BackgroundJobSystem` to assert on `enqueue` calls without spinning up the real queue

---

## Running the Tests

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js \
  --config jest.config.cjs \
  src/tests/deadlineSlash.test.ts
```

Contract coverage for the same state transitions lives in:

```bash
cd contracts/accountability_vault
cargo test
./scripts/check_snapshots.sh
```

---

## Future Work

| Item | Description |
|------|-------------|
| Real `slash_on_miss` submission | Wire `buildSlashOnMissPayload` through `_client.submitSlashOnMiss()` once Soroban RPC is configured |
| Persistent idempotency | Replace in-memory store with a DB-backed table for restart safety |
| Alerting | Emit metrics / alerts when `status = 'not_configured'` in production |

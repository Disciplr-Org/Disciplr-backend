# Expired Vault Settlement Flow

Expired-vault failure and its on-chain settlement are recorded in the database
before submission. This makes the settlement recoverable after a process
restart.

## Expiration scheduler

`startExpirationChecker` acquires the `expiration_scheduler` heartbeat lock and
works in that same transaction. It selects expired active vaults using the
database clock (`end_date <= now()`) with `FOR UPDATE SKIP LOCKED`. Vaults with
no milestones still requiring verification are left alone for the claim flow.
For each remaining vault, the scheduler marks it failed and creates one pending
vault-scoped `redirect` operation with key `slash_on_miss:<vaultId>`. Both
changes commit atomically. The operation records the unverified milestone ID
used by the contract call.

## Settlement worker

The recurring `settlement.process` job reads pending and submitted operations
from `settlement_operations`, locking rows with `SKIP LOCKED` while processing.
Pending rows call Soroban `slash_on_miss`; successful submissions are recorded
with their transaction hash and confirmed. A submitted row left by an
interrupted worker is confirmed on the next tick without submitting again.

Submission errors increment `attempt_count`; transient errors remain pending
until the five-attempt limit, while contract rejections are failed immediately.
Terminal failures emit an alert-level log entry. No vault status is changed by
the worker. `DRY_RUN=true` leaves rows pending and does not call Soroban.

## Retry and identity guarantees

The settlement table enforces exactly one scope (`milestone_id` or `vault_id`)
and has a unique identity index for each scope. The scheduler's row locks and
the unique index prevent duplicate vault operations across concurrent ticks.
Pending database rows are the recovery queue; no in-memory enqueue record is
required.

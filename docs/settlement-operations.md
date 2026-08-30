# Atomic milestone settlement operations

Milestone releases and redirects are represented by a durable settlement
operation. The operation is the unit of retry, not the HTTP request and not a
new blockchain transaction on every retry.

## State machine

```text
pending ──submit──> submitted ──confirm──> confirmed
   ▲                    │
   │                    └──fail──> failed ──submit──> submitted
   └──────────────────────────────────────────────────
```

`confirmed` is terminal. A release or redirect cannot become complete merely
because a worker constructed a transaction or because the submission endpoint
returned. Only a callback carrying the exact submitted transaction hash can
advance `submitted` to `confirmed`.

## Operation identity

Each operation has:

- `milestone_id` and caller-provided `operation_key` as a unique logical
  identity;
- `operation_type`, either `release` or `redirect`;
- a SHA-256 request fingerprint covering the milestone, type, destination,
  amount, and asset;
- `attempt_count`, submitted/confirmed timestamps, and operator-visible
  failure details.

Reusing an operation key with the same request returns the existing operation.
Reusing it with a changed payout destination, amount, or type returns an
identity conflict. This prevents an accidental retry from becoming a second
settlement or from changing the beneficiary under an old key.

## Atomic database behavior

`settlement_operations` has a unique `(milestone_id, operation_key)` index.
Submission, failure recording, and confirmation each run in a transaction,
lock the operation row, and use a conditional status update. Concurrent
workers therefore observe one of these safe outcomes:

| Concurrent action | Result |
| --- | --- |
| same pending operation submitted twice | one attempt, same submitted record returned |
| same submitted operation confirmed twice | one confirmation, same record returned |
| different transaction hash | conflict; original hash is preserved |
| timeout after broadcast | `failed`, then retry with the same operation id |
| process restart | row is recovered by operation id and key |

The final confirmation update is guarded by both operation id, status, and
transaction hash. A late callback for a previous attempt cannot confirm a new
attempt accidentally.

## Recovery procedure

1. Find `pending`, `submitted`, or `failed` rows for the milestone.
2. For `confirmed`, do not submit or retry; the settlement is complete.
3. For `submitted`, reconcile the stored transaction hash with the chain
   before deciding whether to record confirmation or failure.
4. For `failed`, retry `submit` using the existing operation id and logical
   key. Do not create a new key to bypass an unknown outcome.
5. Record the operator-visible failure code and a redacted message when the
   chain or RPC is unavailable.

The `SettlementOperationLedger` mirrors the production transitions and can
snapshot/restore records for deterministic worker and restart tests. The
database adapter is the source of truth in deployed environments.

## Failure and observability trade-offs

The design deliberately preserves failed rows rather than deleting them. This
uses a small amount of storage but gives operators a complete attempt history,
supports safe recovery after a timeout, and prevents duplicate payouts. Error
messages are bounded and must not contain secrets, signing material, or full
request payloads. A monitoring job should alert on old `submitted` operations
and high retry counts; it must not auto-create replacement operations.

## Test coverage

The state-machine tests cover malformed requests, release/redirect identity,
same-key replay, changed-payload conflicts, duplicate submission, transaction
hash conflicts, timeout/rejected-transaction recovery, confirmation gating,
duplicate callbacks, terminal behavior, and restart restoration for every
non-terminal state.


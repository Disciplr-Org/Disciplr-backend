# Horizon reconciliation

The stream listener provides prompt delivery, but the durable vault tables are
the application projection and Horizon is the authoritative source for what a
contract emitted. The reconciliation worker closes the gap between those two
systems after a process crash, an SSE disconnect, a missed page, or an
eventual-consistency delay.

## Responsibilities

The worker has five responsibilities:

1. scan a bounded ledger window for each configured contract;
2. deduplicate event IDs and persist both confirmed and unconfirmed evidence;
3. wait for the configured ledger confirmation depth;
4. apply only monotonic vault status transitions;
5. save a durable high-water mark after the database transaction commits.

The worker does not invent a vault, infer a terminal outcome from a missing
event, or overwrite a terminal status with a different terminal status.
Missing vault dependencies remain visible in the report and can be retried
after the normal event listener catches up.

## Two cursors

`horizon_checkpoints` remains the stream cursor. Reconciliation has its own
state because a stream may have read an event before that event is sufficiently
confirmed. The reconciliation state stores:

- `scan_ledger`: the newest ledger inspected;
- `confirmed_ledger`: the newest ledger whose events passed confirmation;
- `paging_token`: the scanner's resume token;
- `last_error`: the latest durable failure for operators.

On restart the worker begins at `confirmed_ledger - overlap + 1`. The overlap
is intentional. It makes a short reorg-like change or an interrupted page
safe: the same event is read again, the event primary key absorbs the replay,
and the monotonic transition guard prevents a state regression.

## Confirmation policy

An observation at ledger `L` is confirmed when:

```text
latest_ledger - L >= confirmation_depth
```

The depth is configurable and must be non-negative. A page can contain both
confirmed and unconfirmed observations. Both are recorded, but only confirmed
observations are eligible to change `vaults.status`. The next run scans the
overlap and can promote an unconfirmed row without relying on an in-memory
queue.

## Status mapping

The state machine is deliberately conservative:

| Current state | Event state | Result |
| --- | --- | --- |
| missing | any valid event | report missing dependency; do not create silently |
| draft | active | apply |
| draft/active | completed/failed/cancelled | apply |
| active | active | no-op |
| terminal | same terminal state | no-op |
| terminal | different terminal state | no-op and retain audit evidence |

The `whereNotIn` update is defense in depth for concurrent workers. The event
evidence table preserves what Horizon reported even when a transition is
already current or intentionally rejected. This allows an operator to compare
the chain history with the projection without mutating business state during a
diagnostic pass.

## Retry and failure behavior

The scanner is injected behind `HorizonObservationSource`; production adapters
can use Horizon pagination while tests can reproduce gaps and duplicates. A
worker coordinator calls `reconcileWithRetry`, which uses bounded exponential
backoff. A failed page does not advance either cursor. The previous confirmed
cursor is retained, and `last_error` is stored for health checks and alerts.

Database writes use one transaction per page. Event evidence, vault updates,
and their counters either commit together or roll back together. The durable
cursor is saved only after that transaction returns successfully. If the
process stops between those operations, the overlap causes a safe replay.

## Operations

Operators should alert on:

- a growing `latest_ledger - confirmed_ledger` gap;
- repeated `last_error` values for one contract;
- missing-vault counts that remain non-zero after listener catch-up;
- unconfirmed rows older than the expected confirmation interval;
- terminal-state conflicts for the same vault;
- a scan cursor that does not move across several successful runs.

The report is suitable for metrics and structured logs. Do not use a vault ID
or transaction hash as an unbounded metric label; aggregate by contract and
outcome, and retain detailed evidence in the database.

## Deployment checklist

- run the migration before enabling the worker;
- choose confirmation depth using the network's finality guidance;
- start with a small scan window and verify cursor movement;
- compare applied counts with the existing processed-event table;
- verify a restart replays only the overlap and produces no duplicate effects;
- exercise duplicate, gap, late-dependency, and terminal-regression cases;
- wire `last_error`, missing dependencies, and confirmation lag into health;
- keep the worker single-owner per contract or use a scheduler lock;
- review event payload retention and access controls;
- document the selected overlap and confirmation values in deployment config.

The worker is intentionally safe to run more than once. Running it again is a
reconciliation operation, not a second business action.

# Vault Lifecycle Event Processing and Transactional Outbox

To guarantee reliable delivery of vault lifecycle events, Disciplr implements the **Transactional Outbox Pattern**. This architecture decouples event generation (database updates) from event delivery (external webhooks, ETL integrations).

## Batch Event Processing

During catch-up after a listener outage, events are processed in configurable batches to improve ingest throughput.

### Batch Flow

```
 [Events Inbound] ─> [Bulk Dedupe Check] ─> [Single Transaction]
                                               │
                                               ├──> Route each event
                                               ├──> Bulk mark processed_events
                                               └──> Insert outbox events
                                                    │
                                                    ▼
                                          [Commit / Rollback]
```

### Key Design

1. **Bulk Dedupe**: All event IDs in the batch are checked against `processed_events` in a single query. Already-processed events are skipped without database writes.

2. **Single Transaction**: New (non-deduplicated) events are routed inside one database transaction. If the transaction fails mid-batch (e.g. crash, connection drop), **nothing** is committed — idempotency on retry prevents double-application.

3. **Bulk Persist**: After routing all events in the batch, a single `INSERT` with `ON CONFLICT DO NOTHING` marks all attempted events as processed. This is atomic with the batch's business logic writes.

4. **Per-Vault Ordering**: Events within a batch are routed sequentially in their original array order. The batch API caller (e.g. `HorizonListener`) is responsible for ordering events by vault and ledger number before passing them to `processBatch`.

### Configuration

Batch size is set via `ProcessorConfig.batchSize` (default: 50):

```typescript
const processor = new EventProcessor(db, {
  maxRetries: 3,
  retryBackoffMs: 50,
  batchSize: 50,  // events per batch
})
```

### Crash Recovery

If the process crashes during a batch:
- The database transaction is rolled back automatically.
- On restart, the same events are re-processed.
- The bulk dedupe check finds no `processed_events` entries (the batch never committed), so all events are applied again.
- Idempotent inserts (`ON CONFLICT DO NOTHING`) and the full-transaction rollback guarantee no double-application.

### Throughput Metric

Batch throughput (events/second) is exposed as `disciplr_event_throughput_events_per_sec` on the `/api/metrics` endpoint. The gauge is updated after each completed batch based on `(succeeded + skipped) / duration_seconds`.

## Architecture Overview

```
 [Event Inbound] ─> [EventProcessor] (Atomic Transaction)
                         │
                         ├──> Update Vault Status (vaults table)
                         └──> Insert Outbox Event (vault_outbox table)
                                      │
                                      ▼
                              [vault_outbox]
                                      │
                              (SKIP LOCKED claim)
                                      ▼
                              [OutboxRelay Worker]
                                 │            │
                                 ▼            ▼
                           [Webhooks]    [ETL Enqueue]
```

1. **Atomic Writes**: When a vault lifecycle event (e.g. `vault_created`, `vault_completed`, `vault_failed`, `vault_cancelled`) is processed, all domain writes (updating the vaults table) and the outbox event payload insertion are wrapped in a single database transaction. This ensures that an event is never lost if a write succeeds but the network/downstream dispatch fails.
2. **Relay Worker**: A background worker claims unprocessed outbox events using a concurrency-safe database query (`FOR UPDATE SKIP LOCKED`), dispatches them, and marks them as processed.

## Outbox Relay Contract

- **At-Least-Once Semantics**: Downstream consumers are guaranteed to receive every committed event at least once. Under network partitions or crashes during event marking, duplicate dispatches may occur.
- **Consumer Idempotency Requirements**:
  - **Webhooks**: Subscriptions and processors must verify the unique `eventId` in the payload header (`x-disciplr-event-id`) or request body, rejecting duplicates.
  - **ETL Enqueue**: The ETL batch tracking database (`etl_batches`) uses the unique `eventId` as its batch key (`batch_id`). Duplicate enqueues result in a unique constraint key violation, which is ignored, maintaining idempotency.
- **Dead-Letter State**: If an event repeatedly fails delivery, it is moved to a dead-letter state (marked as processed with a `last_error` showing `Exceeded max attempts`) after 5 failed attempts, preventing poison messages from blocking the queue.
- **Metrics**: Relay lag (defined as the age of the oldest unprocessed row in the outbox) is tracked and exposed via `/api/metrics` under `disciplr_outbox_relay_lag_seconds`.

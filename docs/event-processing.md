# Vault Lifecycle Event Processing and Transactional Outbox

To guarantee reliable delivery of vault lifecycle events, Disciplr implements the **Transactional Outbox Pattern**. This architecture decouples event generation (database updates) from event delivery (external webhooks, ETL integrations).

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

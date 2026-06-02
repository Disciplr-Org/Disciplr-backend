# Event Processing Mapping for Vault Lifecycle

This document describes how on-chain events from the Stellar blockchain are mapped to the Disciplr vault lifecycle state in the database.

## Overview

The `EventProcessor` service is responsible for consuming parsed blockchain events and updating the system state consistently. It ensures idempotency, handles out-of-order events through retries, and maintains an audit trail.

## Event Mapping

| On-Chain Event | Database Update | Notes |
|----------------|-----------------|-------|
| `vault_created` | Inserts a new record into the `vaults` table. | Uses `onConflict('id').ignore()` to handle duplicates. |
| `milestone_created` | Inserts a new record into the `milestones` table. | Requires the referenced vault to exist. |
| `milestone_validated` | Inserts a record into `validations` and updates milestone status. | Requires the referenced milestone to exist. |
| `vault_completed` | Updates vault status to `completed`. | |
| `vault_failed` | Updates vault status to `failed`. | |
| `vault_cancelled` | Updates vault status to `cancelled`. | |

### Implementation Note
- Vault status events (`vault_completed`, `vault_failed`, `vault_cancelled`) are applied through `src/services/vaultTransitions.ts`, which centralizes transition rules and updates the persisted vault row.
- Validation events (`milestone_validated`) are recorded in `validations`; `approved` validations also advance the milestone to `completed`.

## Out-of-Order Events

Blockchain events may occasionally arrive out of order (e.g., a milestone creation event processed before its parent vault creation event).

### Strategy: Reject with Retry

If a required dependency (like a Vault or Milestone) is not found in the database when processing an event, the `EventProcessor` throws a `DependencyNotFoundError`. This error is specifically caught and treated as **retryable**.

The processor will retry the operation with exponential backoff. If the parent event arrives and is processed during these retries, the child event will eventually succeed.

## Idempotency

Every event has a unique `eventId` formatted as `{transaction_hash}:{event_index}`. 

1. Before processing, the system checks the `processed_events` table.
2. If the `eventId` exists, the event is skipped as "already processed."
3. If not, the event is processed within a database transaction.
4. Upon success, the `eventId` is recorded in `processed_events` before committing.

## Error Handling & Dead Letter Queue

If an event fails after exhausting all retry attempts (default: 3), it is moved to the `failed_events` table (Dead Letter Queue).

- **Retryable Errors:** Transient failures (network, DB locks) and `DependencyNotFoundError`.
- **Non-Retryable Errors:** Parsing errors or business rule violations that won't resolve with retries.

Failed events can be manually reprocessed via the `reprocessFailedEvent` method once the underlying issue is resolved.

## Security Considerations

- **Contract Allowlist:** The system only processes events from trusted contract addresses (configured in `ProcessorConfig`).
- **Data Validation:** All event payloads are strictly validated in `EventParser` before reaching the processor.

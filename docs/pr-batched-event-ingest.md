# Batched, Transactional Horizon Event Ingest

## Summary

Adds a batched processing path to `EventProcessor` that processes Horizon events in configurable batches with bulk deduplication and transactional persistence, significantly improving catch-up throughput after listener outages.

## Changes

### `src/types/horizonSync.ts`
- Added `batchSize?: number` to `ProcessorConfig`
- Added `BatchProcessingResult` interface with `total`, `succeeded`, `failed`, `skipped`, `durationMs`, and `results`
- Added `ProcessingResult` interface (moved from `eventProcessor.ts`)

### `src/services/idempotency.ts`
- Added `areEventsProcessed(eventIds, trx?)` — bulk dedupe check returning a `Set<string>` of already-processed IDs in a single query
- Added `markEventsProcessed(events, trx)` — bulk insert with `ON CONFLICT DO NOTHING` for atomic processed_events recording

### `src/services/eventProcessor.ts`
- Added `processBatch(events)` — public API for batched processing
  - Single round-trip bulk dedupe check
  - One transaction per batch: routes all non-deduplicated events, then bulk-marks processed
  - Reports throughput metric after completion
- Added `processNewEventsBatch(events)` — private method handling the transactional batch routing
- Added `getBatchSize()` — returns configured batch size (default 50)
- Graceful handling of individual event failures within a batch
- Outbox inserts for vault lifecycle events preserved

### `src/routes/metrics.ts`
- Added `disciplr_event_throughput_events_per_sec` Gauge
- Exported `setEventThroughput()` function called by `EventProcessor`

### `docs/event-processing.md`
- Documented batch processing flow, configuration, crash recovery, and throughput metric

### `src/tests/eventProcessor.batch.test.ts`
Comprehensive test coverage:

**Basic batch processing:**
- Processes unique events and records all as processed
- Configurable batch size getter
- Default batch size (50)

**Batch deduplication:**
- Cross-batch duplicate (already-processed events skipped)
- Mixed batch (new + already-processed events)
- Within-batch duplicate (same event appears twice)

**Crash mid-batch / no double-apply:**
- Simulated mid-batch crash — transaction rolled back, no state change
- Successful retry after failed batch (idempotent replay)

**Per-vault ordering:**
- Events for same vault processed in ledger order
- Events for multiple vaults processed correctly

**Throughput metric:**
- Metric reported on successful batch

**Edge cases:**
- Empty batch
- Mixed event types (vault, milestone, validation) in one batch
- Individual event failure within batch (doesn't affect others)
- Large batch (25 events)
- Same transaction hash with different event indexes

## Design Decisions

1. **Bulk dedupe before transaction**: A single `WHERE IN` query checks all event IDs before the transaction starts, reducing round-trips without sacrificing safety.

2. **One transaction per batch**: All event routing and the bulk `processed_events` insert happen in one transaction. On crash, the entire batch rolls back and is retried idempotently.

3. **Default batch size = 50**: Conservative default that avoids excessive locking while providing meaningful throughput gains.

4. **Throughput as Gauge**: Updated after each batch with `(succeeded + skipped) / duration_seconds`. Best-effort reporting (wrapped in try-catch).

5. **Per-event error isolation**: If one event fails (e.g., missing vault dependency), other events in the batch still succeed. The failed event is still marked as processed to prevent infinite re-delivery loops.

closes #688

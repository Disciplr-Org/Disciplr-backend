# Streaming transaction exports

This document describes the bounded export path implemented for issue #1506.
Exports can contain many vaults and transactions, so the output path must not
turn the complete result into a second, ever-growing string before delivery.

## Goals

The export path provides:

- stable ordering for repeatable downloads;
- bounded producer buffering and consumer backpressure;
- cancellation when a client or upload destination disconnects;
- string-preserving serialization for money, timestamps, and identifiers;
- formula-safe CSV cells;
- explicit authorization at job creation, status, and download boundaries.

The implementation keeps the existing asynchronous export job API. A job still
has a status record and an idempotency key, but streaming-capable formats are
serialized one record at a time when an object-store upload is available.
Local completed-job compatibility continues to use the existing buffer field.

## Data flow

The production flow is:

1. Authenticate the caller and resolve the organization key from the verified
   principal.
2. Enforce the export quota before enqueueing work.
3. Snapshot the requested scope, target, format, and column allowlist in the
   idempotent job record.
4. Fetch data using the job's immutable user scope.
5. Select a streaming serializer for CSV or compressed NDJSON when S3 is
   configured; select the compatibility buffer serializer for JSON and local
   storage.
6. Pipe the readable into the object-store uploader, allowing the destination
   to apply backpressure.
7. Mark the job done only after the stream closes successfully.
8. Expose the signed or authenticated download URL after completion.

No download is marked ready before serialization completes. A failed stream is
handled by the same retry and dead-letter path as a query failure.

## Bounded buffering

`createStreamingExportReadable` uses an async generator and a Node readable
with a 512 KiB high-water mark. The generator yields:

- one JSON line per NDJSON record, then gzip transforms the stream;
- the BOM, section marker, header, and one CSV row per iteration.

The producer pauses when the consumer's writable buffer is full. It resumes
only when demand returns. This avoids joining all rows into one CSV string and
avoids retaining a second serialized copy while an upload is in progress.

The stream itself is intentionally format-aware. CSV headers are emitted once
per section, while each following row is independently escaped. NDJSON keeps
one JSON object per line and uses gzip without changing JSON value types.

## Stable ordering

Rows are ordered before serialization by the data-fetch layer. The stream does
not reorder, parallelize, or merge results. Sections are emitted in this
canonical order:

1. vaults;
2. transactions;
3. analytics.

Stable ordering makes retries and downstream imports deterministic. It also
means a consumer can stop after a complete section without interpreting an
interleaved result.

## Precision preservation

Amounts are selected from PostgreSQL as text and remain strings through the
export model. The streaming serializers pass those values directly to
`JSON.stringify` or CSV conversion. They are never coerced through JavaScript
`Number`, which would lose precision above `Number.MAX_SAFE_INTEGER`.

Identifiers, ledger values, timestamps, and transaction hashes follow the same
principle: values are serialized in their source representation. A downstream
consumer can therefore round-trip an exact amount or identifier without
scientific-notation conversion.

## CSV safety

CSV fields are escaped by `csv-stringify`. In addition, values beginning with
`=`, `+`, `-`, `@`, tab, or carriage return receive a leading apostrophe. This
prevents spreadsheet applications from interpreting exported user-controlled
values as formulas when a CSV is opened interactively.

The mitigation is applied per cell while rows are emitted. It is not a post-
processing pass over the complete document, so it does not increase peak
serialization memory.

## Cancellation and cleanup

Readable streams expose `destroy()` for consumer cancellation. If an HTTP
response closes or an S3 upload aborts, the stream is destroyed and the
generator stops before requesting more rows. The job is not marked `done`.

Database cursor implementations should connect their query cancellation hook
to the stream's `close` or `error` event. The current in-memory compatibility
source is finite and synchronous per row; production data fetches remain
scoped to the authenticated job and should use a cursor or bounded page query
when the database adapter exposes one.

Cleanup requirements are:

- stop requesting rows after cancellation;
- release the query cursor/client in a `finally` block;
- avoid retrying a stream that was deliberately cancelled by the caller;
- retry transport failures only while the job attempt budget remains;
- leave no partially completed job status behind.

## Authorization model

Authorization is checked at all three stages:

| Stage | Rule |
| --- | --- |
| Create `/me` | Caller can export only their resolved scope |
| Create `/admin` | Caller must be an authenticated admin |
| Status | Non-admin caller can read only their own job |
| Download | Owner, organization member, or admin only |

The job stores the target and organization context at creation time. A client
cannot change the target by modifying a later download request. Download
responses also record an audit event without placing raw user identifiers in
structured logs.

## Empty and large exports

An empty stream is valid and completes with the format's empty representation:

- CSV contains the UTF-8 BOM and no fabricated data rows;
- NDJSON contains no JSON records after decompression.

Large exports are not special-cased by an all-at-once join operation. The
same generator handles one row and many rows, making peak serialization memory
independent of the total output size apart from the source data page currently
held by the fetch layer.

## Compatibility

Existing JSON serialization remains available because local job storage and
some integrations expect a completed buffer. The new stream is selected for
CSV and NDJSON object-store uploads, where the destination can consume a
readable incrementally. Existing route-level download authorization,
idempotency, quota, and signed URL behavior are preserved.

The stream filename preserves the established timestamped naming scheme. CSV
retains its UTF-8 BOM and section markers. NDJSON retains gzip compression and
the `.ndjson.gz` suffix.

## Test evidence

`src/services/exportStreaming.test.ts` covers:

- empty output;
- deterministic section and row ordering;
- exact large amount strings in CSV and NDJSON;
- column allowlists;
- spreadsheet formula mitigation;
- high-water-mark configuration;
- a 2,000-row fixture;
- consumer cancellation;
- one header per section;
- all three sections in the compressed format.

Existing `src/routes/exports.test.ts` continues to cover idempotent enqueue,
status authorization, completed downloads, content types, and privacy-safe
logs.

Run focused validation with:

```text
pnpm exec jest src/services/exportStreaming.test.ts src/routes/exports.test.ts --runInBand
```

Run lint for the streaming implementation with:

```text
pnpm exec eslint src/services/exportQueue.ts src/services/exportStreaming.test.ts
```

## Operational considerations

Object-store uploads should set a content type matching the selected format.
CSV uses `text/csv; charset=utf-8`; JSON uses `application/json;
charset=utf-8`; compressed NDJSON uses `application/x-ndjson` with the
existing gzip filename convention.

Monitoring should distinguish query failures, serialization failures, upload
failures, and client cancellations. The export job attempt count and DLQ
context provide the retry boundary; stream metrics should additionally expose
bytes transferred and cancellation count without logging account identifiers.

If the destination repeatedly applies backpressure, the producer should remain
paused. Increasing the high-water mark to hide a slow consumer would trade a
temporary latency problem for unbounded memory pressure, which is precisely
the failure mode this design is intended to prevent.

## Failure-mode matrix

The following table defines the expected behavior for the important boundaries
in the export lifecycle:

| Failure | Observable result | Required cleanup |
| --- | --- | --- |
| Invalid format | HTTP 400 before enqueue | No quota-consuming job |
| Invalid column name | HTTP 400 before enqueue | No query is started |
| Quota exhausted | HTTP 429 with retry metadata | No job is created |
| Query failure | Retryable job failure | Release database resources |
| CSV conversion failure | Serialization failure | Stop readable and retry |
| S3 upload failure | Retryable upload failure | Abort multipart upload |
| Client disconnect | Closed/cancelled stream | Stop requesting rows |
| Unauthorized status read | HTTP 403 | Do not reveal job state |
| Unauthorized download | HTTP 403 | Do not reveal result bytes |
| Empty result | Successful empty document | Mark done normally |

Failures before a job exists do not create an orphan record. Failures after a
job exists update its attempt state and are retried only within the configured
maximum. A job is placed in the dead-letter path after the final failed
attempt, with privacy-sanitized context.

## Consumer guidance

Consumers should treat the response as a stream and avoid collecting it into a
single application string. For a browser download, use the response body as a
blob stream. For an import worker, parse each NDJSON line or each CSV record as
it arrives. If a consumer needs to resume, it should start a new export job
with the same idempotency key and request snapshot rather than replaying an
unknown partial byte range.

Consumers must preserve amount fields as decimal strings. Converting them to a
binary floating-point number can lose units even when the original export is
correct. Timestamps should likewise be treated as ISO strings ending in `Z`;
they identify instants and should not be reparsed as local wall-clock values.

## Security review checklist

Before changing this path, reviewers should verify:

1. The job scope is derived from verified authentication state.
2. Admin-only target selection remains behind the admin middleware.
3. A status or download request cannot replace the original target user.
4. Column names are checked against the section schema rather than interpolated
   into SQL.
5. CSV formula mitigation remains enabled for every streamed string cell.
6. Object-store keys continue to use sanitized job and filename segments.
7. Audit records do not contain raw account identifiers in structured logs.
8. Cancellation cannot mark a partial result as completed.
9. Retry behavior cannot create duplicate completed jobs for one idempotency key.
10. Stream changes do not bypass the existing quota or organization checks.

## Performance expectations

The stream tests intentionally use a 2,000-row fixture and a 10,000-row
cancellation fixture. They verify that output remains correct as row count
grows and that cancellation does not require draining the full fixture. A
production cursor or paginated query should keep the input page bounded as
well; the serializer cannot repair an upstream query that loads the entire
database into memory.

The 512 KiB high-water mark is a backpressure threshold, not a promised exact
allocation. Node streams may hold a small amount of additional bookkeeping and
the object-store SDK may maintain its own multipart part buffer. The important
property is that no serializer-level operation creates a second full-size
joined document.

## Rollout plan

1. Deploy the stream implementation with the existing local-buffer fallback.
2. Enable it for object-store CSV uploads and compare byte counts with prior
   exports.
3. Watch upload failures, retries, cancellation rate, and memory usage.
4. Confirm downloaded CSV and NDJSON fixtures match their prior schemas.
5. Keep the fallback until object-store and downstream importer metrics are
   stable across a representative large-export window.

Rollback is safe because the job schema and external formats are unchanged.
Disabling object-store streaming selects the existing buffer serializer; it
does not alter authorization, idempotency, or the stored request snapshot.

## Review evidence

The implementation is intentionally small at the serializer boundary: one
shared column filter, one CSV cell policy, and one readable factory. Keeping
these rules together prevents local and object-store exports from drifting.
The tests consume the readable fully for correctness and destroy a live
readable for cancellation, covering both normal completion and early close.

This keeps the issue's bounded-memory and disconnect-safety guarantees visible
to maintainers as the export formats evolve.

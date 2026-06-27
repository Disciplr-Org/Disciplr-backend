# Exports

The exports pipeline now runs through the background job system using the `export.generate` job type.

## OpenAPI Schemas

The export endpoints are documented via `@asteasolutions/zod-to-openapi` schemas defined in `src/docs/openapi-generator.ts`:

| Schema | Description |
|--------|-------------|
| `ExportRequest` | Query params for `POST /api/exports/me` and `POST /api/exports/admin` (`format`, `scope`, optional `targetUserId`) |
| `ExportJobResponse` | 202 response with `jobId`, `statusUrl`, and `pollIntervalMs` |
| `ExportJobStatus` | Poll response with `status`, `attempts`, optional `downloadUrl` and `error` |

Regenerate the spec after schema changes:

```bash
npm run openapi:generate
npm run openapi:validate
```

## Flow

1. `POST /api/exports/me` or `POST /api/exports/admin` persists an `export_jobs` row.
2. The API enqueues `export.generate` with the persisted export job id.
3. The worker loads the export job, generates the payload, stores the file bytes (in S3 or locally), and marks the job as `done`.
4. Clients poll `GET /api/exports/status/:jobId` and download with the signed link returned after completion.

## S3 upload and signed URLs

When `EXPORT_S3_BUCKET` and `EXPORT_S3_REGION` are both configured, completed exports are uploaded to S3 using streaming multipart upload via `@aws-sdk/lib-storage`. The export job record stores the S3 key instead of the file bytes.

On poll, `GET /api/exports/status/:jobId` returns a short-lived pre-signed S3 URL instead of the local download token.

**Environment variables:**

| Variable                   | Required | Default | Description                                    |
| -------------------------- | -------- | ------- | ---------------------------------------------- |
| `EXPORT_S3_BUCKET`         | No       | –       | S3 bucket name for export storage             |
| `EXPORT_S3_REGION`         | No       | –       | AWS region for the S3 bucket                  |
| `EXPORT_SIGNED_URL_TTL_S`  | No       | `3600`  | Signed URL expiration in seconds (1 hour)     |

**Behavior:**

- When S3 is configured, `result_data` remains `NULL` in the database and the `s3_key` column contains the S3 object key.
- When S3 is not configured, `result_data` stores the generated file bytes and `s3_key` remains `NULL`.
- The status endpoint returns either a signed S3 URL (when S3 is enabled) or a local `/api/exports/download/:token` URL (when S3 is disabled).

**AWS credentials:**

The S3 client uses the standard AWS SDK credential resolution chain (environment variables, IAM instance profile, or shared credentials file). No additional configuration is required beyond setting the bucket and region.

## Durability and retries

- Export job state is persisted in `export_jobs`, including attempts, terminal errors, and generated file bytes.
- Retry progress is written back on every attempt. Retryable failures move the job back to `pending`.
- On worker startup, any export jobs left in `pending` or `running` state are re-enqueued.
- Request-level idempotency is supported through the `Idempotency-Key` header. Reusing the same key with a different request shape returns `409`.

## Security

- Non-admin users only export their own data.
- Admin exports can target a specific user or all users.
- Status polling is restricted to the requesting user unless the caller is an admin.
- Download links are signed and time-limited.
- CSV cells that start with spreadsheet formula prefixes such as `=`, `+`, `-`, `@`, tab, or carriage return are prefixed with `'` to mitigate formula injection.

## Per-tenant export quotas

Each organization (or individual user when no org context is present) is limited to a configurable number of export requests per UTC calendar day.

### How it works

- On every `POST /api/exports/me` and `POST /api/exports/admin` the quota counter for the resolved tenant is checked **before** a job is enqueued.
- The tenant is identified by `orgId` when it is attached to the request (e.g. via `requireOrgAccess` middleware), falling back to the authenticated `userId`.
- Quotas reset automatically at UTC midnight (no manual action required).
- Counters are stored in the `org_quotas` table (in-memory in test environments, Knex/PostgreSQL in production).

### 429 response

When the daily limit is exceeded the API returns:

```
HTTP 429 Too Many Requests
Retry-After: <seconds until UTC midnight>
Content-Type: application/json

{
  "error": "Export quota exceeded. Try again tomorrow.",
  "retryAfter": 3600
}
```

The `Retry-After` value is the number of seconds remaining until the quota resets at midnight UTC.

### Configuration

| Environment variable       | Default | Description                            |
| -------------------------- | ------- | -------------------------------------- |
| `EXPORT_DAILY_QUOTA_LIMIT` | `100`   | Max export requests per tenant per day |

## Dead-Letter Queue (DLQ)

When an export job exhausts all retry attempts and permanently fails, the ExportQueue moves it to an in-memory DLQ with a structured failure record.

### DlqEntry structure

| Field | Description |
|-------|-------------|
| `jobId` | Export job identifier |
| `jobType` | `{scope}:{format}` (e.g. `vaults:csv`) |
| `failureReason` | `serialization_error`, `data_fetch_error`, or `unknown_error` |
| `errorMessage` | PII-sanitised error message |
| `attemptCount` | Number of attempts made |
| `failedAt` | ISO-8601 UTC timestamp |
| `sanitisedContext` | Job metadata with `userId`/`targetUserId` replaced by opaque SHA-256 tokens |

### Failure taxonomy

- **`serialization_error`** — error during CSV or JSON serialisation
- **`data_fetch_error`** — error while fetching export data from vault store or database
- **`unknown_error`** — any other error (S3, repository, etc.)

### DLQ operations (internal service methods)

| Method | Returns | Description |
|--------|---------|-------------|
| `getDlqEntries()` | `DlqEntry[]` | Newest-first read-only snapshot |
| `getDlqEntry(jobId)` | `DlqEntry \| undefined` | Lookup by job ID |
| `getDlqDepth()` | `number` | Current entry count |
| `requeueDlqEntry(jobId)` | `Promise<boolean>` | Remove from DLQ, reset job to `pending` with `attempts: 0` |
| `discardDlqEntry(jobId)` | `boolean` | Permanently remove from DLQ |
| `clearDlq()` | `number` | Remove all entries, returns count |

### Configuration

```ts
configureDlq({ maxSize: 200, metricsHook: myHook })
```

- `maxSize` — maximum entries (default `100`); oldest entry evicted on overflow
- `metricsHook` — optional callback `(event: DlqMetricsEvent) => void` invoked on add, requeue, discard, and clear; failures are caught and logged

### PII safety

`userId` and `targetUserId` are replaced with the first 8 characters of their SHA-256 hash via `maskPii` before storage or emission. Raw Stellar addresses, email addresses, and other PII fields listed in `PRIVACY.md` are stripped from `sanitisedContext` and `errorMessage`.

## CSV behavior

- CSV output uses UTF-8 with BOM for spreadsheet compatibility.
- Column ordering is explicit and stable for vaults, transactions, and analytics sections.
- Empty datasets still emit section headers and CSV headers so downstream consumers receive a valid file shape.

## Performance note

Large exports are now stored in S3 when `EXPORT_S3_BUCKET` and `EXPORT_S3_REGION` are configured, avoiding database bloat from large binary columns. When S3 is not configured, generated bytes are stored directly in the `result_data` column for backward compatibility and simplified local development.

For production deployments serving large organizations, enabling S3 storage is strongly recommended.

### NDJSON streaming chunk size

NDJSON exports stream through gzip with `DEFAULT_NDJSON_EXPORT_CHUNK_ROWS = 256`.

The benchmark in `src/tests/performance/exportStream.perf.test.ts` simulates a slow client, verifies gzip/NDJSON framing, compares throughput across `1`, `64`, `256`, and `512` row chunks, and asserts the slow-consumer path remains below a 24 MiB heap-growth ceiling.

The default is intentionally a middle value: it avoids the per-row overhead of `1` row chunks while staying small enough to keep backpressure responsive for large org exports and aborted clients.

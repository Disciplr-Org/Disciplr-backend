# Exports

The exports pipeline now runs through the background job system using the `export.generate` job type.

## OpenAPI Schemas

The export endpoints are documented via `@asteasolutions/zod-to-openapi` schemas defined in `src/docs/openapi-generator.ts`:

| Schema | Description |
|--------|-------------|
| `ExportRequest` | Query params for `POST /api/exports/me` and `POST /api/exports/admin` (`format`, `scope`, optional `targetUserId`, optional `columns`) |
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

## Format Negotiation

Export formats can be selected via:
- **Query parameter**: `?format=csv` (or `json` or `ndjson`)
- **Accept header**: `Accept: text/csv`, `Accept: application/json`, `Accept: application/x-ndjson`

The query parameter takes precedence over the Accept header. The default format is `json`.

| Format | MIME Type(s) | Description |
|--------|--------------|-------------|
| `csv` | `text/csv` | UTF-8 encoded CSV with BOM for spreadsheet compatibility, section headers for each data type |
| `json` | `application/json` | Pretty-printed JSON object with sections for each data type |
| `ndjson` | `application/x-ndjson` | Newline-delimited JSON, gzipped when uploaded to S3 |

## Column Selection

You can optionally select which columns to include in the export via the `columns` query parameter, which takes a JSON object mapping section names to arrays of column keys.

### Example

Request only `id` and `status` for vaults, and `txHash` and `amount` for transactions:
```
POST /api/exports/me?scope=all&format=csv&columns={"vaults":["id","status"],"transactions":["txHash","amount"]}
```

### Allowed Columns

#### Vaults (`vaults`)
- `id`
- `creator`
- `amount`
- `status`
- `startDate`
- `endDate`
- `verifier`
- `successDestination`
- `failureDestination`
- `createdAt`

#### Transactions (`transactions`)
- `id`
- `userId`
- `vaultId`
- `txHash`
- `type`
- `amount`
- `assetCode`
- `fromAccount`
- `toAccount`
- `memo`
- `stellarLedger`
- `stellarTimestamp`
- `explorerUrl`
- `createdAt`

#### Analytics (`analytics`)
- `userId`
- `totalVaults`
- `activeVaults`
- `completedVaults`
- `totalAmount`
- `exportedAt`

## S3 upload and signed URLs

When `EXPORT_S3_BUCKET` and `EXPORT_S3_REGION` are both configured, completed exports are uploaded to S3 using streaming multipart upload via `@aws-sdk/lib-storage`. The export job record stores the S3 key instead of the file bytes.

On completion, `GET /api/exports/status/:jobId` returns a proxied download link (`/api/exports/:id/download`) rather than exposing long-lived raw S3 signed URLs directly.

**Environment variables**:

| Variable                        | Required | Default | Description                                    |
| ------------------------------- | -------- | ------- | ---------------------------------------------- |
| `EXPORT_S3_BUCKET`              | No       | –       | S3 bucket name for export storage             |
| `EXPORT_S3_REGION`              | No       | –       | AWS region for the S3 bucket                  |
| `EXPORT_SIGNED_URL_TTL_S`       | No       | `3600`  | Default fallback signed URL expiration in seconds |
| `EXPORT_SIGNED_URL_SHORT_TTL_S` | No       | `60`    | Short-lived S3 signed URL TTL for proxied downloads |

**Behavior**:
- When S3 is configured, `result_data` remains `NULL` in the database and the `s3_key` column contains the S3 object key.
- When S3 is not configured, `result_data` stores the generated file bytes and `s3_key` remains `NULL`.
- The status endpoint returns the authenticated download endpoint `/api/exports/:id/download`.
- When accessing `GET /api/exports/:id/download`, callers are re-authenticated and verified for organization ownership. When S3 is configured, a short-lived signed URL (default 60s TTL) is issued.

## Durability and retries

- Export job state is persisted in `export_jobs`, including attempts, terminal errors, generated file bytes, and column selection.
- Retry progress is written back on every attempt. Retryable failures move the job back to `pending`.
- On worker startup, any export jobs left in `pending` or `running` state are re-enqueued.
- Request-level idempotency is supported through the `Idempotency-Key` header. Reusing the same key with a different request shape returns `409`.

## Security & Proxied Download Re-Authorization

- **Authenticated Proxied Downloads (`GET /api/exports/:id/download`)**: Requires valid authentication bearer token.
- **Per-Object Organization Ownership & Authorization**: The caller's organization ID is verified against the export job's owning organization. Cross-tenant or unauthorized access attempts are rejected with `403 Forbidden`.
- **Short-Lived S3 Presigned Links**: S3 presigned URLs are generated with short expiration windows (e.g. 60 seconds) during proxied downloads and are never embedded in list/status responses without authorization.
- **Audit Logging**: Every download attempt is recorded in tamper-evident audit logs (`export.download`) with the requesting principal, export job ID, and organization context.
- Non-admin users only export and access their own organization's data. Admin exports can target specific users or global data.
- CSV cells starting with formula prefixes (`=`, `+`, `-`, `@`, tab, carriage return) are prefixed with `'` to prevent formula injection.
- Column selection is validated against an allowlist.

## Per-tenant export quotas

Each organization (or individual user when no org context is present) is limited to a configurable number of export requests per UTC calendar day.

### How it works

- On every `POST /api/exports/me` and `POST /api/exports/admin` the quota counter for the resolved tenant is checked **before** a job is enqueued.
- The tenant is identified by `orgId` when it is attached to the request (e.g., via `requireOrgAccess` middleware), falling back to the authenticated `userId`.
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

| Environment variable       | Default | Description                                    |
| -------------------------- | ------- | ---------------------------------------------- |
| `EXPORT_DAILY_QUOTA_LIMIT` | `100`   | Max export requests per tenant per day         |

## Dead-Letter Queue (DLQ)

When an export job exhausts all retry attempts and permanently fails, the ExportQueue moves it to an in-memory DLQ with a structured failure record.

### DlqEntry structure

| Field | Description |
|-------|-------------|
| `jobId` | Export job identifier |
| `jobType` | `{scope}:{format}` (e.g., `vaults:csv`) |
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
- Selected columns are reflected in the CSV output.

## Performance note

Large exports are now stored in S3 when `EXPORT_S3_BUCKET` and `EXPORT_S3_REGION` are configured, avoiding database bloat from large binary columns. When S3 is not configured, generated bytes are stored directly in the `result_data` column for backward compatibility and simplified local development.

For production deployments serving large organizations, enabling S3 storage is strongly recommended.

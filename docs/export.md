# Data Export API

## Endpoints

### User-level export

```
POST /api/exports/me?format=json&scope=all
Authorization: Bearer <token>
```

Returns a job reference immediately (HTTP 202). Poll the status URL until `status === "done"`, then download via the signed URL.

### Admin export

```
POST /api/exports/admin?format=csv&scope=vaults&targetUserId=<uid>
Authorization: Bearer <admin-token>
```

Same async flow. `targetUserId` is optional — omit to export **all** users' data.

### Poll status

```
GET /api/exports/status/:jobId
Authorization: Bearer <token>
```

Response while running:

```json
{ "jobId": "…", "status": "pending" | "running" | "failed" }
```

Response when done:

```json
{
  "jobId": "…",
  "status": "done",
  "completedAt": "2025-01-01T00:00:00.000Z",
  "downloadUrl": "/api/exports/download/<signed-token>",
  "expiresInSeconds": 3600
}
```

### Download

```
GET /api/exports/download/:signedToken
```

No `Authorization` header required — the signed token is the credential.
Returns the file with appropriate `Content-Type` and `Content-Disposition` headers.

CSV downloads are emitted as UTF-8 with a leading BOM so spreadsheet tools such as Microsoft Excel preserve non-ASCII characters correctly on open.

---

## Query Parameters

| Param          | Values                                       | Default        |
| -------------- | -------------------------------------------- | -------------- |
| `format`       | `json`, `csv`                                | `json`         |
| `scope`        | `vaults`, `transactions`, `analytics`, `all` | `all`          |
| `targetUserId` | any user ID                                  | — (admin only) |

---

## Production upgrade checklist

| Concern         | Current (stub)            | Recommended                       |
| --------------- | ------------------------- | --------------------------------- |
| Auth            | Base64-decoded payload    | `jsonwebtoken` + RS256            |
| Background jobs | `setTimeout` in-process   | Bull / BullMQ + Redis             |
| Job persistence | `Map<string, Job>`        | PostgreSQL `export_jobs` table    |
| File storage    | `Buffer` in memory        | S3 / GCS pre-signed URLs          |
| Download secret | Env var `DOWNLOAD_SECRET` | AWS Secrets Manager / Vault       |
| Data source     | Shared in-memory array    | Parameterised DB queries per user |

---

## Dead-Letter Queue (DLQ)

When an export job exhausts all retry attempts it is moved to an in-memory DLQ. The DLQ is queryable and drainable at runtime via service methods — no API surface change is required.

### DLQ Entry structure (`DlqEntry`)

```ts
interface DlqEntry {
  jobId: string          // original ExportJob id
  jobType: string        // "scope:format", e.g. "vaults:csv"
  failureReason: FailureReason
  errorMessage: string
  attemptCount: number
  failedAt: string       // ISO-8601 UTC
  sanitisedContext: {
    userToken: string        // first 8 chars of SHA-256(userId) — no raw PII
    targetUserToken?: string // first 8 chars of SHA-256(targetUserId) if set
    scope: ExportScope
    format: ExportFormat
  }
}
```

`FailureReason` is one of `serialization_error | data_fetch_error | unknown_error` and is
classified automatically from the caught error message.

### DLQ capacity

The DLQ is capped at `maxDlqSize` entries (default **100**). When the cap is reached the
oldest entry is evicted before the new one is inserted. Configure at startup:

```ts
import { configureDlq } from './services/exportQueue.js'
configureDlq({ maxDlqSize: 200 })
```

### Query API

| Method | Description |
|---|---|
| `getDlqEntries()` | Snapshot of all entries, newest-first. Mutations to the returned array do not affect the store. |
| `getDlqEntry(jobId)` | Single entry or `undefined`. |
| `getDlqDepth()` | Current entry count. |

### Drain API

| Method | Returns | Description |
|---|---|---|
| `requeueDlqEntry(jobId)` | `Promise<boolean>` | Removes from DLQ and re-creates the job as `pending` with reset attempts. Returns `false` if `jobId` not found. |
| `discardDlqEntry(jobId)` | `boolean` | Permanently removes entry. Returns `false` if not found. |
| `clearDlq()` | `number` | Removes all entries; returns count of removed entries. |

### Optional metrics hook

Register a callback at startup to receive a `DlqMetricsEvent` on every DLQ mutation:

```ts
import { configureDlq, type DlqMetricsEvent } from './services/exportQueue.js'

configureDlq({
  metricsHook: (event: DlqMetricsEvent) => {
    // event.event   — 'dlq.entry_added' | 'dlq.entry_requeued' | 'dlq.entry_discarded' | 'dlq.cleared'
    // event.jobId   — affected job id (empty string for 'dlq.cleared')
    // event.dlqDepth — depth after the mutation
    // event.timestamp — ISO-8601 UTC
    myMetricsClient.gauge('export.dlq.depth', event.dlqDepth)
  }
})
```

A throwing hook is caught and logged at `warn` level — it never interrupts normal queue
operation.

### Structured log lines emitted by the DLQ

| Event | Level | Key fields |
|---|---|---|
| Entry added | `warn` | `jobId`, `failureReason`, `errorMessage`, `attemptCount`, `dlqDepth` |
| Entry requeued | `info` | `jobId`, `dlqDepth` |
| Entry discarded | `info` | `jobId`, `dlqDepth` |
| DLQ cleared | `info` | `count`, `dlqDepth` |

All log lines are structured JSON and contain **no raw `userId` or `targetUserId`**.

### PII contract

- `userId` and `targetUserId` are replaced by a deterministic opaque token (first 8 hex chars
  of SHA-256) before storage in `DlqEntry.sanitisedContext`.
- Raw Stellar account addresses, email addresses, and any field classified as PII in
  `PRIVACY.md` are never written to a `DlqEntry`.
- The metrics hook receives only the sanitised event — no PII is emitted via the hook.

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

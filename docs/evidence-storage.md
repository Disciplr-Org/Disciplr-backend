# Evidence Storage Contract

This service stores signed object-storage references for verification evidence without persisting raw PII or document contents.

## What is stored

- `verification_id` — links the reference to the recorded verification decision.
- `evidence_hash` — integrity checksum for the submitted evidence payload.
- `reference_url` — signed object-storage URL (e.g. S3-compatible signed URL).
- `expires_at` — expiry timestamp extracted from the signed URL.
- `created_at` — insertion timestamp.

## What is not stored

- Raw evidence files.
- User-uploaded document contents.
- Sensitive personal data from the payload.

## Ingestion rules

- `POST /api/verifications` now accepts `evidenceHash` and `evidenceReferenceUrl`.
- `evidenceHash` must be a non-empty alphanumeric-hyphen-underscore string between 32 and 128 characters.
- `evidenceReferenceUrl` must be an HTTP/HTTPS signed object-storage URL.
- URL expiry is validated by parsing one of:
  - `X-Amz-Expires` with `X-Amz-Date`
  - `Expires`
  - `expires`
- Expired URLs are rejected.

## SSRF Protection

Evidence URL references are validated with SSRF protection that blocks requests to internal, private, and cloud-metadata addresses. This protects against:

- **Server-side request forgery** — an attacker submitting a malicious evidence URL designed to trigger requests to internal services
- **Cloud metadata endpoint attacks** — accessing AWS/GCP/Azure metadata endpoints
- **DNS rebinding** — a hostname that initially resolves to a safe IP but later rebinds to a private IP

### Blocked IP Ranges

The following IP ranges are always blocked, regardless of allowlist configuration:

| Range | Purpose | Examples |
|-------|---------|----------|
| `10.0.0.0/8` | RFC1918 private network | `10.0.0.1` — `10.255.255.255` |
| `172.16.0.0/12` | RFC1918 private network | `172.16.0.1` — `172.31.255.255` |
| `192.168.0.0/16` | RFC1918 private network | `192.168.1.1` — `192.168.255.255` |
| `127.0.0.0/8` | Loopback | `127.0.0.1`, `127.0.0.2`, etc. |
| `::1` | IPv6 loopback | `[::1]` |
| `169.254.0.0/16` | Link-local / cloud metadata | `169.254.169.254` (AWS/GCP metadata) |

### Blocked Hostnames

The following hostnames are always blocked:

- `localhost` and `*.localhost`
- `localtest.me` (DNS rebinding vector)

### Scheme Allowlist

Only `https://` is permitted in production. `http://` is permitted only for:

- Local development environments
- Intra-datacenter communication (when explicitly configured via `EVIDENCE_ALLOWLIST`)

### Host Allowlist

By default (no allowlist configured), evidence URLs may reference any public hostname. To restrict evidence storage to specific hosts, configure:

```bash
EVIDENCE_ALLOWLIST=storage.example.com,cdn.example.com,s3.amazonaws.com
```

The allowlist:
- Is comma-separated
- Supports subdomains (e.g., `example.com` allows `api.example.com`, `cdn.example.com`, etc.)
- Is case-insensitive
- **Still enforces private IP blocking** — a hostname cannot be allowlisted if it resolves to a private IP

Fallback behavior:

- If `EVIDENCE_ALLOWLIST` is not set, the system falls back to `WEBHOOK_ALLOWED_HOSTS` (allowing webhook and evidence to use the same allowlist)
- If neither is set, all public-IP hostnames are allowed

### DNS Rebinding Mitigation

The hostname is validated at the socket level using the same logic as webhook delivery:

1. The hostname is parsed from the URL
2. `isUrlAllowed()` (from `src/services/webhooks.ts`) validates the hostname against blocked ranges
3. Before each fetch, the URL is re-validated to catch rebinding attacks

This prevents an attacker from:
- Submitting a URL for `my-malicious-domain.com` that initially resolves to a public IP
- The domain later rebinding to `169.254.169.254` to access cloud metadata

### Adding New Storage Providers

To allowlist a new evidence storage provider:

1. **Verify the provider's IP range** — ensure it uses public IPs and not shared infrastructure (e.g., AWS regions with mixed public/private endpoints)
2. **Add to `EVIDENCE_ALLOWLIST`** — include the provider's hostname or domain
   ```bash
   EVIDENCE_ALLOWLIST=storage.example.com,existing-provider.com
   ```
3. **Document in this file** — add the provider to the list below

#### Current Approved Providers

| Provider | Hostname | Notes |
|----------|----------|-------|
| AWS S3 | `*.s3.amazonaws.com`, `s3.*.amazonaws.com` | Use region-specific or bucket-specific endpoints |
| Google Cloud Storage | `storage.googleapis.com` | |
| Azure Blob Storage | `*.blob.core.windows.net` | Use storage account-specific endpoints |

## Persistence

A new `evidence_references` table stores evidence metadata.
This table is created by the new database migration `db/migrations/20260527000000_create_evidence_references.cjs`.

## Audit logging

Audit logs do not include the raw signed URL.
Only evidence metadata such as `evidenceHash` and the fact that evidence was attached are recorded.

Blocked SSRF attempts are logged as warnings without including the full URL to prevent leaking internal topology:

```
[Evidence] SSRF protection blocked unsafe evidence URL
```

## Similarity Search

To detect near-duplicate or low-effort submissions, evidence supports a hybrid similarity search combining vector embeddings and keyword/text matching.

### Hybrid Search Implementation
- **Vector Search (HNSW)**: The `milestone_embeddings` table uses an HNSW index on the `embedding` column with the `vector_cosine_ops` operator class.
  - **Tradeoffs**: HNSW provides superior recall and faster query times compared to IVFFlat, though it consumes slightly more memory and index build time.
  - **Parameters**: Built with `m = 16` and `ef_construction = 64` as standards for 768-dimensional embeddings.
- **Keyword Search (pg_trgm)**: The `evidence_references` table is indexed with GIN indexes (`gin_trgm_ops`) on `reference_url` and `evidence_hash`.
  - This acts as a fallback for evidence that shares few embedded features but has exactly or near-exactly matching URLs or hashes.
- **Scoring**: A fused score is calculated as `w1 * vector_distance + w2 * keyword_distance`. Both vector and keyword use distance metrics where `0` implies an exact match.

## Relationship to milestone embeddings

This service intentionally does **not** generate or store embeddings — see "What is not stored"
above. Similarity-search embeddings for milestones (used for near-duplicate / low-effort
submission detection) are a separate subsystem keyed by `milestone_id`, not evidence rows, and are
kept in sync by an offline reindex backfill job. See "Embedding reindex backfill job" in
`docs/milestones.md` for that job's design, resumability, and rate-limiting.

## Security Notes

### Implementation Details

- SSRF validation occurs in `src/services/evidence.ts` via the `validateEvidenceUrlSafety()` function
- Reuses the same `isUrlAllowed()` logic as webhook delivery for consistency (see `src/services/webhooks.ts`)
- Both `createEvidenceReference()` and `fetchEvidenceContent()` validate URLs before accepting or fetching
- HTTP redirects are rejected during fetch to prevent redirect-based SSRF (using `redirect: 'manual'`)

### Defense-in-Depth

SSRF validation happens at two points:

1. **At reference creation** (`createEvidenceReference()`) — blocks storage of unsafe URLs
2. **Before each fetch** (`fetchEvidenceContent()`) — catches configuration changes or bypasses

This dual validation ensures that:
- Misconfigured allowlists don't leak access to internal services
- Future changes to the allowlist don't retroactively expose old references
- DNS rebinding after reference creation is caught before fetch

### Audit and Compliance

- Blocked SSRF attempts are logged (without URL details) for security audits
- Evidence references are immutable (created via `ON CONFLICT DO UPDATE`) — once accepted, the URL cannot be changed
- All URL validation is deterministic and testable (see `src/tests/evidence.ssrf.test.ts`)

## Embedding Model-Version Drift Detection

Each row in `milestone_embeddings` records the `model_version` that produced it. When the active provider version (controlled by `EMBEDDING_MODEL_VERSION`) changes, stored embeddings become stale and silently degrade similarity search.

### Drift report

```
GET /api/admin/embeddings/drift
Authorization: Bearer <admin-token>
```

Response:
```json
{
  "currentModelVersion": "deterministic-v2",
  "totalEmbeddings": 1000,
  "currentCount": 750,
  "staleCount": 250,
  "versions": [
    { "modelVersion": "deterministic-v1", "count": 200, "isCurrent": false },
    { "modelVersion": "legacy-unversioned", "count": 50, "isCurrent": false },
    { "modelVersion": "deterministic-v2", "count": 750, "isCurrent": true }
  ]
}
```

### Triggering a re-embed

```
POST /api/admin/embeddings/reembed
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "reset_cursor": false, "max_batches": 5 }
```

- `reset_cursor` (default `false`) — set to `true` to restart the backfill from the beginning.
- `max_batches` (default `5`) — maximum batches to process per call. Each batch is `50` milestones.

The run is **incremental and resumable**: the backfill cursor is persisted in `backfill_cursors` under job name `milestone-evidence-embedding-reindex`. A crashed or timed-out run picks up where it left off on the next call.

Rows already on the current model version are skipped (no double-processing).

Response (`202 Accepted`):
```json
{
  "batches": 5,
  "processed": 250,
  "reindexed": 200,
  "skippedUpToDate": 50,
  "cursor": "m-00250",
  "done": false
}
```

Call repeatedly until `done: true`.

Both endpoints are admin-only and audit-logged under `admin.embeddings.drift.read` and `admin.embeddings.reembed.triggered`.

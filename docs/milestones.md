# Milestones API

Milestones represent verifiable tasks or conditions that must be completed for a vault to transition to the "completed" state. Each milestone is assigned to a specific verifier who is responsible for validating its completion.

## Check-in Grace Window (`lateCheckInWindowSecs`)

By default, a verifier must validate a milestone **on or before its `dueDate`**. Setting `lateCheckInWindowSecs` on the vault allows a configurable grace period after `dueDate` during which check-in is still accepted.

### How it works

```
effectiveDeadline = min(dueDate + lateCheckInWindowSecs, vault.endDate)
```

- If `now ≤ effectiveDeadline` → check-in accepted.
- If `now > effectiveDeadline` → `400 DeadlinePassed`.
- The window is always bounded by the vault's `endDate` so it can never extend beyond the vault lifetime.
- If a milestone has no `dueDate`, no deadline is enforced regardless of the grace window.

### Configuration

Pass `lateCheckInWindowSecs` when creating a vault:

```json
{
  "amount": "1000",
  "startDate": "2030-01-01T00:00:00.000Z",
  "endDate": "2030-06-01T00:00:00.000Z",
  "verifier": "G...",
  "destinations": { "success": "G...", "failure": "G..." },
  "lateCheckInWindowSecs": 3600,
  "milestones": [
    { "title": "Kickoff", "dueDate": "2030-02-01T00:00:00.000Z", "amount": "500" }
  ]
}
```

| Field | Type | Default | Constraints |
|---|---|---|---|
| `lateCheckInWindowSecs` | integer | `0` | ≥ 0; bounded by vault `endDate` at runtime |

### Boundary behaviour

| Scenario | Result |
|---|---|
| `now < dueDate` | ✅ Accepted |
| `dueDate < now ≤ dueDate + graceWindow` (and `≤ endDate`) | ✅ Accepted |
| `now > dueDate + graceWindow` | ❌ `400 DeadlinePassed` |
| `now > endDate` (even within grace window) | ❌ `400 DeadlinePassed` |
| No `dueDate` on milestone | ✅ Accepted (no deadline) |

## Milestone Validation

### POST /api/vaults/:vaultId/milestones/:milestoneId/validate

Validates a milestone as completed. Only the assigned verifier can perform this action, and validation is idempotent (cannot be repeated).

**Authentication:** Required (JWT Bearer token)
**Authorization:** VERIFIER role required, must be the assigned verifier for the milestone
**Idempotency:** Yes - repeated validations return conflict error

#### Request

- **Method:** POST
- **Path:** `/api/vaults/:vaultId/milestones/:milestoneId/validate`
- **Headers:**
  - `Authorization: Bearer <jwt-token>`
- **Body:** Empty

#### Response

**Success (200):**
```json
{
  "milestone": {
    "id": "string",
    "vaultId": "string",
    "description": "string",
    "verified": true,
    "verifiedAt": "2024-01-01T00:00:00.000Z",
    "verifiedBy": "verifier-user-id",
    "verifierId": "verifier-user-id",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "vaultCompleted": false
}
```

**Errors:**
- `401 Unauthorized` - Missing or invalid authentication
- `403 Forbidden` - User is not a verifier or not the assigned verifier
- `404 Not Found` - Vault or milestone does not exist
- `409 Conflict` - Milestone already validated

#### Authorization Rules

1. **Role Check:** User must have VERIFIER role
2. **Active Verifier:** Verifier account must be active
3. **Assignment Check:** User must be the assigned verifier for the milestone (`milestone.verifierId`)
4. **Replay Protection:** Cannot validate an already validated milestone

#### Events

Successful validation emits:
- `milestone.validated` domain event with validator and timestamp
- If all milestones are validated, `vault.state_changed` to `completed`

#### Security Considerations

- Verifier identity verified from authenticated JWT context, not request headers
- Prevents IDOR by validating milestone belongs to specified vault
- Idempotent to prevent replay attacks
- All validation attempts logged with actor information

---

## pgvector — Milestone Embeddings (Similarity Search)

### Overview

The `milestone_embeddings` table stores 768-dimensional vector embeddings for milestone evidence text. These are used to detect near-duplicate or low-effort submissions by performing cosine-similarity search via the [pgvector](https://github.com/pgvector/pgvector) PostgreSQL extension.

Embeddings are populated asynchronously by an offline job after evidence is submitted; the table is deliberately separate from the core milestone tables so the feature can be enabled/disabled without schema churn.

### Database Schema

```sql
-- Extension (enabled by migration)
CREATE EXTENSION IF NOT EXISTS vector;

-- Table
CREATE TABLE milestone_embeddings (
  milestone_id  UUID          PRIMARY KEY,
  embedding     vector(768)   NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- IVFFlat index for approximate nearest-neighbour search
CREATE INDEX idx_milestone_embeddings_vector
  ON milestone_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

### Migration

The migration is applied automatically via Knex:

```bash
npm run migrate:latest
```

The migration file is `db/migrations/20260602000000_create_milestone_embeddings.cjs`.

To roll back:

```bash
npm run migrate:rollback
```

Rolling back drops the `milestone_embeddings` table but intentionally **leaves the `vector` extension** in place, as other tables may depend on it.

### Repository API — `MilestoneRepository`

Located at `src/repositories/milestoneRepository.ts`.

| Method | Signature | Description |
|---|---|---|
| `upsertEmbedding` | `(milestoneId: string, embedding: number[]) => Promise<void>` | Insert or replace the embedding for a milestone. |
| `nearestNeighbors` | `(milestoneId: string, k?: number) => Promise<NearestNeighborResult[]>` | Return up to `k` nearest neighbours (default 5) by ascending cosine distance, excluding the queried milestone itself. |
| `findEmbedding` | `(milestoneId: string) => Promise<MilestoneEmbedding \| null>` | Retrieve the stored embedding record, or `null` if absent. |
| `deleteEmbedding` | `(milestoneId: string) => Promise<void>` | Remove the embedding (e.g. when the milestone is deleted). |

#### Example

```typescript
import knex from 'knex'
import { MilestoneRepository } from './src/repositories/milestoneRepository.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL })
const repo = new MilestoneRepository(db)

// Store an embedding produced by an offline embedding model
await repo.upsertEmbedding('milestone-uuid', embeddingVector)

// Find the 5 most similar milestones
const neighbours = await repo.nearestNeighbors('milestone-uuid', 5)
// => [{ milestone_id: '...', distance: 0.04 }, ...]
```

### `NearestNeighborResult` type

```typescript
interface NearestNeighborResult {
  milestone_id: string
  distance: number  // cosine distance in [0, 2]; lower = more similar
}
```

### Environment Requirements

| Requirement | Notes |
|---|---|
| PostgreSQL ≥ 13 | Minimum supported version for pgvector |
| pgvector ≥ 0.5.0 | `CREATE EXTENSION vector` must succeed |
| `DATABASE_URL` env var | Standard connection string |

If pgvector is not installed on the target database, the migration will fail with:

```
ERROR: extension "vector" is not available
```

Install pgvector on your PostgreSQL server before running migrations:

```bash
# Debian / Ubuntu
sudo apt-get install postgresql-16-pgvector

# Docker — use pgvector/pgvector image
# docker run -e POSTGRES_PASSWORD=pw pgvector/pgvector:pg16
```

### Tests

Tests live in `src/tests/milestoneEmbeddings.test.ts`. They are automatically **skipped** when `DATABASE_URL` is not set or the `vector` extension is not available in the target database, so they never block CI builds that run without a full PostgreSQL service.

To run the full suite against a local database:

```bash
DATABASE_URL=postgres://user:pw@localhost:5432/disciplr_test npm test -- milestoneEmbeddings
```

## Embedding reindex backfill job

The pgvector section above notes that embeddings are "populated asynchronously by an offline
job" — `embeddings.reindex` is that job. It keeps `milestone_embeddings` in sync with the
`milestones` table, fixing drift caused by an embedding-model change, a failed enqueue, or a
fresh `milestone_embeddings` migration where no rows exist yet.

### Why a reindex is needed

A row in `milestone_embeddings` is considered **stale or missing** when either is true:

- No row exists for that `milestone_id` at all.
- The row's `model_version` no longer matches the currently configured embedding model
  (`CURRENT_EMBEDDING_MODEL_VERSION`, see `src/services/embeddingProvider.ts`, sourced from the
  `EMBEDDING_MODEL_VERSION` env var, default `deterministic-v1`).

The `model_version` column (migration `20260627000000_add_model_version_to_milestone_embeddings.cjs`)
defaults existing legacy rows to the sentinel `legacy-unversioned`, which never matches a real
configured model — so every embedding that predates this job is picked up and regenerated on the
first run.

### How it works

Core logic lives in `src/services/evidenceReindex.ts`:

- **`reindexEvidenceBatch(options)`** — processes one bounded page of the `milestones` table
  (ordered by `id` ascending), regenerates any missing/stale embedding, and advances a persisted
  cursor to the last milestone id seen in that page.
- **`runReindexBatches(options)`** — runs up to `maxBatchesPerRun` batches (default 5) in one job
  invocation, stopping early once the table is fully caught up. This bounds how long a single job
  execution can take.

The job is registered as `embeddings.reindex` in `src/jobs/types.ts` / `src/jobs/handlers.ts`, and
runs on a recurring schedule from `BackgroundJobSystem` (every `EMBEDDING_REINDEX_INTERVAL_MS`,
default 10 minutes; first run 15s after startup). It can also be enqueued on demand:

```ts
jobSystem.enqueue('embeddings.reindex', { batchSize: 100, maxBatchesPerRun: 10 })
```

### Resumability

The cursor (last processed milestone id) is persisted via `BackfillCursorStore`
(`src/services/backfillCursorStore.ts`, table `backfill_cursors`, migration
`20260627000001_create_backfill_cursors.cjs`) under job name
`milestone-evidence-embedding-reindex`. If the process crashes or restarts mid-backfill, the next
run resumes from the persisted cursor instead of rescanning rows that are already current.

### Rate limiting

Between successive embedding-provider calls **within a batch**, the job awaits `rateLimitMs`
(default 50ms) so it never fires requests at the provider back-to-back. Rows that are skipped
because they're already current do not count towards this delay — only actual regenerations do.

### Embedding text and provider

The embedding input text is the milestone's `title` and `description` (the same plaintext fields
already stored on the `milestones` row — no raw evidence content is read or stored, consistent
with the evidence-storage privacy contract in `docs/evidence-storage.md`).

The default provider (`DeterministicEmbeddingProvider` in `src/services/embeddingProvider.ts`) is
a network-free, deterministic provider: the same text always produces the same vector, which is
what makes the backfill idempotent and keeps tests free of real API calls. Swap in a real model
by implementing the `EmbeddingProvider` interface and passing it into `BackgroundJobSystem`'s
constructor.

### Progress metrics

After every batch, progress is recorded via `recordEmbeddingReindexProgress` in
`src/services/dbMetrics.ts` and readable via `getEmbeddingReindexProgress()`:

```ts
import { getEmbeddingReindexProgress } from './src/services/dbMetrics.js'

getEmbeddingReindexProgress()
// => { processed, reindexed, skippedUpToDate, cursor, done, modelVersion, recordedAt }
```

### Tests

`src/tests/evidence.reindex.test.ts` covers the batch/run logic, `MilestoneRepository`'s reindex
support methods, `BackfillCursorStore`, the embedding provider, and the `embeddings.reindex` job
handler — all against lightweight in-memory fakes, so the suite runs without a live database (no
`DATABASE_URL` or pgvector required).

# Milestone Completion Trends & Behavioral Insights

This document describes the calculations and assumptions used by the analytics endpoints.

## Endpoints

- GET /api/analytics/milestones/trends
  - Query: from, to (ISO 8601), groupBy=day|week|month, userId (optional)
  - Response: buckets of counts per period
    - periodStart: ISO UTC start of period
    - success, failed, total

- GET /api/analytics/behavior
  - Query: userId (required), windowDays=30, baseScorePerSuccess=5, penaltyPerFailure=2, streakBonusPerDay=1
  - Response: per-user metrics and a behaviorScore

## Data Model

In-memory milestone events:

- id: string
- userId: string
- vaultId: string
- name: string
- status: success | failed
- timestamp: ISO 8601

## Calculations

### Trends

- Group events into day/week/month buckets using UTC boundaries:
  - day: 00:00:00.000Z of the day
  - week: Monday 00:00:00.000Z at the start of the ISO week
  - month: 00:00:00.000Z of the 1st of the month
- For each bucket, count success, failed, total.

### Behavior

Inputs:

- windowDays: number of days ending at “now” (UTC), inclusive
- baseScorePerSuccess: additive score for each success
- penaltyPerFailure: subtractive penalty for each failure
- streakBonusPerDay: additive bonus per consecutive successful day up to today

Steps:

1. Select events for userId where timestamp ∈ [start, now].
2. successes = count where status = success; failures = count where status = failed.
3. streakDays = number of consecutive UTC days ending today where user has ≥1 success.
4. behaviorScore = successes * baseScorePerSuccess − failures * penaltyPerFailure + streakDays * streakBonusPerDay.

## Batch Loader

### Problem: N+1 per-vault reads

When analytics are computed for an org with N vaults, a naïve implementation
issues one query per vault to fetch its status, capital, and milestone counts.
For large orgs this dominates latency (O(N) round-trips).

### Solution: `AnalyticsBatchLoader`

`src/services/analyticsBatchLoader.ts` provides a **request-scoped** batch
loader that coalesces all per-vault and per-milestone reads into at most **one
query per entity type** using SQL `IN (…)` clauses.

```
N vaults  →  1 vault query  +  1 milestone query  (constant, not O(N))
```

Key properties:

- **Deduplication** – repeated keys in a single `loadVaults` / `loadMilestones`
  call are deduplicated before the query is issued.
- **Intra-request caching** – keys already fetched within the same loader
  instance are served from an in-memory Map; no extra DB round-trip.
- **No cross-request leakage** – create a new `AnalyticsBatchLoader` (or use
  `createAnalyticsBatchLoader()`) for every request or background job.  Never
  share a loader instance across requests.
- **Tenant isolation** – callers must only pass vault IDs that belong to the
  requesting org.  The loader applies no tenant filter of its own; isolation is
  enforced by the caller.

### Usage

```ts
import { getOrgAnalyticsBatched } from './services/analytics.service.js'

// vaultIds must all belong to the same org/tenant
const analytics = getOrgAnalyticsBatched(vaultIds)
```

Or use the loader directly for custom aggregation:

```ts
import { createAnalyticsBatchLoader } from './services/analyticsBatchLoader.js'

const loader = createAnalyticsBatchLoader()            // one per request
const vaultMap    = loader.loadVaults(vaultIds)        // 1 query
const milestoneMap = loader.loadMilestones(vaultIds)   // 1 query
// loader.queries === 2
```

### Query-count guarantee (verified in tests)

| Before (N+1)        | After (batched)         |
|---------------------|-------------------------|
| N vault queries     | 1 vault query           |
| N milestone queries | 1 milestone query       |

See `src/tests/performance/analyticsBatch.perf.test.ts` for coverage of dedup,
query-count reduction, result parity, and tenant isolation.

---

## Assumptions

- Timezone: all grouping and streaks use UTC boundaries.
- Week start: Monday (ISO week).
- Partial data: empty periods are omitted from the response. Clients may expand to full ranges as needed.
- Storage: events are in-memory for now; replace with a database or event store in production.

## Examples

Trends example bucket:

```json
{
  "buckets": [
    { "periodStart": "2025-01-01T00:00:00.000Z", "success": 3, "failed": 1, "total": 4 }
  ],
  "groupBy": "day",
  "generatedAt": "2025-01-15T12:34:56.000Z"
}
```

Behavior example:

```json
{
  "userId": "user-42",
  "window": { "from": "2025-01-01T00:00:00.000Z", "to": "2025-01-15T00:00:00.000Z", "days": 15 },
  "metrics": { "successes": 10, "failures": 2, "streakDays": 5 },
  "behaviorScore": 53,
  "weights": { "baseScorePerSuccess": 5, "penaltyPerFailure": 2, "streakBonusPerDay": 1 },
  "generatedAt": "2025-01-15T12:34:56.000Z"
}
```

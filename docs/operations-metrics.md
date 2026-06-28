# Database Metrics & Operations

## Overview

The Admin DB Metrics endpoint provides real-time database pool health monitoring and slow query sampling for operational insights and debugging. This document covers usage, security, and integration details.

**Endpoint:** `GET /api/admin/db/metrics`  
**Authentication:** Required (Bearer token)  
**Authorization:** Admin only  
**Rate Limit:** 20 requests per minute per admin user/IP  
**Response Time:** < 100ms

## Prometheus Scraper Authentication

The Prometheus metrics endpoint at `GET /api/metrics` is protected by a dedicated access guard (`src/middleware/metricsAuth.ts`) independent of the JWT-based auth used elsewhere.

### Access methods (either is sufficient)

1. **Bearer token** — set `METRICS_TOKEN` env var; scraper sends `Authorization: Bearer <token>`
2. **IP allowlist** — set `METRICS_ALLOWLIST` env var as a comma-separated list of IPs or CIDR ranges (e.g. `10.0.0.0/8,192.168.1.1`)

If neither is configured the endpoint denies all requests (fail-closed).

### Localhost sidecar

Add `127.0.0.1` to `METRICS_ALLOWLIST`:

```
METRICS_ALLOWLIST=127.0.0.1
```

### Audit trail

Every scrape attempt is logged as a structured JSON line (rate-limited to ≤1 entry per IP per 60 s):

```
{"level":"info","event":"metrics.scrape","ip":"10.0.0.1","allowed":true,"reason":"valid_token","timestamp":"..."}
{"level":"info","event":"metrics.scrape_denied","ip":"10.0.0.1","allowed":false,"reason":"invalid_token","timestamp":"..."}
```

### Prometheus scrape config example

```yaml
scrape_configs:
  - job_name: 'disciplr'
    metrics_path: /api/metrics
    static_configs:
      - targets: ['app:3000']
    authorization:
      credentials: '<METRICS_TOKEN>'
```

### Gauge label hygiene

All emitted gauges carry only aggregate dimensions — no tenant, organisation, or user-identifying labels are present. This prevents leaking per-tenant queue depths or request volumes through the metrics endpoint.

### See Also

For SLO targets, alert rules, remediation procedures, and on-call guidance, see the **[On-Call SLO and Alerting Runbook](runbooks/on-call-slo.md)**. This runbook defines SLOs for job queue depth, DB connection pool, and listener lag, with Prometheus alert rules and escalation procedures.

## Security & Compliance

### 1. Authorization & Access Control

- **Admin-Only:** All metrics access requires `ADMIN` role (enforced via RBAC middleware)
- **Authentication:** JWT bearer token required (`Authorization: Bearer <token>`)
- **Rate Limiting:** Dedicated rate limiter (20 req/min) prevents abuse and resource exhaustion
- **Audit Logging:** All metrics access logged with actor ID and metadata for compliance

### 2. Data Protection

The endpoint implements **PII sanitization** at query aggregation level:

| Data Type | Pattern | Sanitized Value | Example |
|-----------|---------|-----------------|---------|
| Email Addresses | `user@domain.com` | `{email}` | User emails in WHERE clauses |
| UUID Values | `550e8400-...` | `{uuid}` | User IDs, vault IDs, etc. |
| Numeric Values | Any number | `{num}` | Amounts, IDs, timestamps |
| Quoted Strings | `'any value'` | `{value}` | String literals, constants |

**Example Sanitization:**
```
Raw Query:
SELECT * FROM transactions 
WHERE user_id = 12345 
AND email = 'admin@example.com'
AND vault_id = '550e8400-e29b-41d4-a716-446655440000'

Sanitized Pattern:
SELECT * FROM transactions WHERE user_id = {num} AND email = {email} AND vault_id = {uuid}
```

### 3. No Secrets Exposure

- **Connection Strings:** Not exposed (pool config only includes min/max sizes)
- **Environment Variables:** `DATABASE_URL` never included in response
- **Hostnames:** No internal hostnames, only connection counts
- **Credentials:** Pool doesn't store credentials in accessible properties

### 4. Threat Model & Mitigations

| Threat | Mitigation |
|--------|-----------|
| **Reconnaissance** (learning DB schema) | Query patterns only show statement types (SELECT/INSERT/etc), not column/table names after sanitization |
| **PII Extraction** | All user data, emails, UUIDs, amounts replaced with placeholders |
| **Resource Exhaustion** | Rate limiting (20 req/min per user) prevents DoS |
| **Privilege Escalation** | Admin-only enforcement via RBAC middleware |
| **Audit Trail Evasion** | All accesses logged with actor ID and timestamp |

## API Response Format

### Successful Response (200)

```json
{
  "data": {
    "timestamp": "2024-03-28T10:15:30.123Z",
    "isHealthy": true,
    "pool": {
      "available": 8,
      "waiting": 0,
      "total": 8,
      "capacity": {
        "min": 2,
        "max": 10
      }
    },
    "slowQueries": [
      {
        "hash": "a1b2c3d4",
        "pattern": "SELECT * FROM transactions WHERE user_id = {num} AND status = {value}",
        "maxDurationMs": 245,
        "occurrences": 5,
        "lastOccurred": "2024-03-28T10:14:15.000Z"
      }
    ],
    "warnings": [
      "High number of slow queries detected (15)"
    ]
  }
}
```

### Error Responses

**401 Unauthorized** - Missing or invalid token:
```json
{
  "error": "Unauthorized: Missing or invalid token"
}
```

**403 Forbidden** - Non-admin user:
```json
{
  "error": "Forbidden: Insufficient permissions",
  "message": "Requires role: ADMIN"
}
```

**429 Too Many Requests** - Rate limit exceeded:
```json
{
  "error": "Metrics endpoint rate limit exceeded. Please try again later.",
  "retryAfter": 60
}
```

**503 Service Unavailable** - Database pool unavailable:
```json
{
  "error": "Database pool unavailable",
  "status": "unavailable"
}
```

## Response Fields Explained

### Pool Metrics

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `available` | number | Idle connections ready for queries | 8 |
| `waiting` | number | Client requests waiting for a connection | 0 |
| `total` | number | Total active + idle connections | 8 |
| `capacity.min` | number | Minimum pool size configuration | 2 |
| `capacity.max` | number | Maximum pool size configuration | 10 |

**Interpretation Guide:**
- `available ≈ capacity.max` → Good health
- `available = 0` → Pool under stress, query latency may increase
- `waiting > 0` → Connections are contended
- `total ≈ capacity.max` → Consider increasing pool size

### Slow Queries

| Field | Type | Description |
|-------|------|-------------|
| `hash` | string | Content-hash of normalized query pattern (for deduplication) |
| `pattern` | string | Sanitized query template with placeholders (first 150 chars) |
| `maxDurationMs` | number | Longest observed duration for this query pattern |
| `occurrences` | number | How many times this pattern was executed (exceeding 100ms threshold) |
| `lastOccurred` | string | ISO timestamp of most recent occurrence |

**Default Thresholds:**
- **Slow Query Threshold:** 100ms (configurable, see Implementation)
- **Max Tracked Queries:** 50 patterns in-memory (LRU eviction)
- **Max Response Queries:** 20 most impactful patterns returned

### Health Warnings

Common warnings include:
- `"No idle connections available - pool may be under stress"`
- `"N clients waiting for connections"`
- `"Pool is at 90% capacity - consider scaling"`
- `"High number of slow queries detected (N)"`

## Usage Examples

### Get Current Pool Status

```bash
curl -X GET "http://localhost:3000/api/admin/db/metrics" \
  -H "Authorization: Bearer <admin-token>"
```

### Parse Response (Node.js)

```typescript
import { pool } from './db/index.js'
import { getDBHealthMetrics } from './services/dbMetrics.js'

const metrics = getDBHealthMetrics(pool)

if (!metrics.isHealthy) {
  console.warn('Database pool is unhealthy:', metrics.warnings)
}

metrics.slowQueries.forEach(query => {
  if (query.maxDurationMs > 500) {
    console.warn(`Slow query detected: ${query.pattern} (${query.maxDurationMs}ms)`)
  }
})
```

### Monitor Pool Health (Cron Job)

```bash
# Check metrics every 5 minutes
*/5 * * * * curl -s "http://localhost:3000/api/admin/db/metrics" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | \
  jq '.data.warnings | if length > 0 then "ALERT: " + (. | join(", ")) else "OK" end'
```

## Implementation Details

### Slow Query Tracking

**Location:** `src/services/dbMetrics.ts`

The `SlowQueryTracker` class maintains an in-memory registry of slow queries:

1. **Recording:** When a query exceeds 100ms threshold, it's normalized and hashed
2. **Aggregation:** Identical query patterns are counted together (tracking occurrence count)
3. **Eviction:** When 50 patterns are tracked, oldest (by `lastOccurred`) is evicted (LRU)
4. **Sorting:** Queries sorted by total impact: `duration × count`

**Query Normalization Algorithm:**
```
1. Replace all quoted strings → {value}
2. Replace all numbers → {num}
3. Replace emails (regex) → {email}
4. Replace UUIDs (regex) → {uuid}
5. Normalize whitespace (collapse to single spaces)
6. Truncate to 150 characters
7. Generate hash from normalized string
```

### Integration Points

To capture slow queries, wrap query execution with timing:

```typescript
import { recordSlowQuery } from './services/dbMetrics.js'

const startTime = Date.now()
const result = await db.query(sql, params)
const durationMs = Date.now() - startTime

recordSlowQuery(sql, durationMs)
```

This integration should be added to:
- Knex query middleware (via `.on('query')`)
- Direct pg.Pool query calls
- ORM hooks (if using Prisma, TypeORM, etc.)

## Testing

### Test Coverage

Test file: `tests/admin.dbmetrics.test.ts`

**Coverage Areas:**
- ✓ Authentication (401 for missing token, invalid token)
- ✓ Authorization (403 for non-admin users)
- ✓ Response structure and data types
- ✓ PII sanitization (emails, UUIDs, numbers)
- ✓ Query aggregation (identical queries counted together)
- ✓ Query separation (different queries tracked separately)
- ✓ Impact sorting (queries sorted by duration × count)
- ✓ Threshold filtering (< 100ms queries ignored)
- ✓ Rate limiting (429 after 20 requests/min)
- ✓ Audit logging (access recorded)
- ✓ No secrets exposure (connection strings not leaked)
- ✓ Whitespace normalization
- ✓ Mixed PII pattern handling

**Test Command:**
```bash
npm test -- tests/admin.dbmetrics.test.ts
```

**Expected Coverage:** 95%+ for aggregation logic

## Operational Runbook

### Scenario 1: Pool Under Stress

**Symptoms:**
```json
{
  "available": 0,
  "waiting": 3,
  "total": 10,
  "warnings": ["No idle connections available - pool may be under stress"]
}
```

**Actions:**
1. Check application logs for long-running queries
2. Review slow query results for optimization opportunities
3. Consider increasing pool size (`max` parameter in db/index.ts)
4. Check for connection leaks (not being returned to pool)

### Scenario 2: High Slow Query Count

**Symptoms:**
```json
{
  "slowQueries": [...20 queries...],
  "warnings": ["High number of slow queries detected (20)"]
}
```

**Actions:**
1. Identify most impactful query (highest `duration × occurrences`)
2. Add index to frequently queried columns
3. Review query pattern for optimization (e.g., N+1 problems)
4. Consider query caching if results are stable

### Scenario 3: Single Problematic Query

**Symptoms:**
```json
{
  "slowQueries": [
    {
      "pattern": "SELECT * FROM transactions WHERE status = {value}",
      "maxDurationMs": 1200,
      "occurrences": 8
    }
  ]
}
```

**Actions:**
1. Identify the query from pattern and run EXPLAIN ANALYZE
2. Check if table has index on `status` column
3. Consider query rewrite to be more specific
4. Monitor after fix to confirm improvement

## Configuration & Customization

### Adjust Slow Query Threshold

**File:** `src/services/dbMetrics.ts`

```typescript
private readonly thresholdMs = 100 // Change to 200ms for higher threshold
```

**Impact:** Higher threshold = fewer queries tracked, better performance

### Adjust Max Tracked Patterns

**File:** `src/services/dbMetrics.ts`

```typescript
private readonly maxSamples = 50 // Change to 100 for more patterns
```

**Impact:** More patterns = more memory used, but richer data

### Adjust Rate Limit

**File:** `src/middleware/rateLimiter.ts`

```typescript
export const metricsRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,    // Time window
  max: 20,                 // Requests per window
})
```

## Troubleshooting

### Endpoint Returns 503

**Cause:** Database pool not initialized

**Fix:** Ensure `DATABASE_URL` environment variable is set and database is accessible

### No Slow Queries Recorded

**Cause:** Query recording middleware not integrated

**Fix:** Add `recordSlowQuery()` calls to query middleware in your database layer

### High Memory Usage

**Cause:** Large number of unique queries with > 50 patterns

**Fix:** Increase LRU eviction or raise slow query threshold to reduce tracked patterns

### Rate Limit Errors During Monitoring

**Cause:** Monitoring script making too many requests

**Fix:** Reduce check frequency or use multiple admin tokens to distribute requests

## Performance Impact

- **Metrics Retrieval:** < 5ms (in-memory access only)
- **Query Recording:** < 1ms overhead per query (hash calculation only)
- **Memory Footprint:** ~10KB per tracked query pattern, max ~500KB for 50 patterns
- **CPU Impact:** Negligible (simple hash calculations)

**Recommendation:** Safe to call metrics endpoint every 30-60 seconds in production monitoring.

## Security Audit Checklist

- [x] Admin-only authorization enforced
- [x] JWT authentication required
- [x] Rate limiting prevents DoS
- [x] Query patterns sanitized (no PII)
- [x] Connection strings not exposed
- [x] All access logged to audit trail
- [x] No internal hostnames leaked
- [x] Response structure validated in tests
- [x] 95%+ test coverage for aggregation
- [x] SQL injection impossible (no raw SQL returned)

## Future Enhancements

- **Persistent Storage:** Store metrics in time-series DB (InfluxDB, Prometheus) for historical trending
- **Query Recommendations:** AI-powered query optimization suggestions
- **Custom Thresholds:** Per-endpoint slow query thresholds
- **Query Execution Plans:** Optional EXPLAIN ANALYZE integration
- **Performance Baselines:** Track metrics against expected SLAs
- **Alerting Integration:** Send warnings to PagerDuty/Slack when thresholds exceeded

---

## Slow-Query Ring Buffer

### Overview

In addition to the aggregated `SlowQueryTracker`, the service maintains an in-process **ring buffer** that records every individual slow query as it happens. Entries are fingerprints only — raw parameter values are never stored.

**Endpoint:** `GET /api/admin/db/slow-queries`
**Authentication:** Required (Bearer token)
**Authorization:** Admin only
**Response:** Entries ordered oldest → newest

### Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `SLOW_QUERY_THRESHOLD_MS` | `200` | Minimum duration (ms) before a query is captured |
| `SLOW_QUERY_BUFFER_SIZE` | `100` | Maximum entries in the ring buffer (oldest evicted on overflow) |

### Response Format

```json
{
  "data": {
    "count": 2,
    "thresholdMs": 200,
    "bufferSize": 100,
    "entries": [
      {
        "fingerprint": "select * from vaults where id = ?",
        "durationMs": 312,
        "capturedAt": "2026-06-28T00:00:01.000Z"
      },
      {
        "fingerprint": "select * from transactions where user_id = ? and status = ?",
        "durationMs": 485,
        "capturedAt": "2026-06-28T00:00:05.000Z"
      }
    ]
  }
}
```

### Fingerprinting

SQL strings are normalized before storage to strip all literal values:

| Pattern | Replaced with |
|---------|---------------|
| Quoted strings `'value'` | `?` |
| Integer literals `42` | `?` |
| Float literals `3.14` | `?` |
| Positional params `$1`, `$2` | `?` |

Whitespace is collapsed and the fingerprint is capped at 200 characters.

### Knex Integration

`captureSlowQuery` is called automatically via Knex event hooks in `src/db/knex.ts`:

- `query` — records start time keyed by `__knexQueryUid`
- `query-response` — computes elapsed time and calls `captureSlowQuery`
- `query-error` — same as above, so failed slow queries are also captured

### Memory Footprint

Each entry holds a fingerprint string (≤200 chars), a number, and an ISO timestamp string. At the default buffer size of 100 entries this is well under 100 KB.

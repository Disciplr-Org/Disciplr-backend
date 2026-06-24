# Performance Testing

This document describes the performance smoke testing infrastructure for the Disciplr backend API.

## Overview

Performance smoke tests are automated tests that detect performance regressions in key list endpoints. They help identify:

- **N+1 query problems**: When the number of database queries grows linearly with the dataset size
- **Missing indexes**: When queries perform full table scans instead of using indexes
- **Slow response times**: When endpoints exceed acceptable response time thresholds

These tests run in CI with conservative thresholds to avoid flakiness while still catching significant performance issues.

## Test Coverage

### Endpoints Tested

1. **`GET /api/vaults`** - Vault listing endpoint
   - No pagination
   - With pagination
   - With sorting
   - With filtering
   - Combined operations

2. **`GET /api/transactions`** - Transaction listing endpoint
   - First page
   - Cursor pagination
   - Type filtering
   - Date range filtering
   - Vault-specific listing
   - Deep pagination

3. **`GET /api/analytics/*`** - Analytics endpoints
   - Summary
   - Overview
   - Vaults analytics
   - Vault-specific analytics
   - Milestone trends
   - Behavior analytics

### Test Data Volumes

- **Vaults**: 1,000 records
- **Transactions**: 5,000 records
- **Users**: Created as needed for foreign key relationships

These volumes are realistic for smoke testing while keeping test execution time reasonable.

## Performance Thresholds

### Current Per-Endpoint Budgets

Budgets are defined in `src/tests/helpers/performanceHelpers.ts` as
`ENDPOINT_PERFORMANCE_BUDGETS`. Endpoint tests should call `getPerformanceBudget()`
instead of duplicating threshold literals.

| Endpoint scenario | Max response time | Max query count | Expected index coverage |
| --- | ---: | ---: | --- |
| `vaults.list` | 750ms | 4 | `idx_vaults_status_end_date`, `idx_vaults_end_date` |
| `vaults.deepPagination` | 1200ms | 6 | `idx_vaults_status_end_date` |
| `vaults.combinedSortFilter` | 900ms | 5 | `idx_vaults_status_end_date` |
| `transactions.list` | 900ms | 5 | `idx_transactions_stellar_timestamp` |
| `transactions.cursorPagination` | 1000ms | 5 | `idx_transactions_stellar_timestamp` |
| `transactions.byVault` | 900ms | 5 | `idx_transactions_stellar_timestamp` |
| `transactions.combinedSortFilter` | 1100ms | 6 | `idx_transactions_type_created_at`, `idx_transactions_stellar_timestamp` |
| `analytics.summary` | 350ms | 2 | constant-time summary path |
| `analytics.overview` | 250ms | 1 | no DB read expected |
| `analytics.vaults` | 350ms | 2 | `idx_vaults_status_end_date` |
| `analytics.milestoneTrends` | 650ms | 3 | in-memory milestone event scan |
| `analytics.behavior` | 650ms | 3 | in-memory milestone event scan |

### Threshold Philosophy

Thresholds are set conservatively to:
- Avoid false positives in CI environments with variable performance
- Still catch significant regressions (e.g., N+1 queries, missing indexes)
- Allow for reasonable overhead from test infrastructure

### Tuning Thresholds

If tests become flaky or too lenient:

1. **Analyze actual performance**: Run tests locally and review logs
2. **Check for regressions**: Compare current vs. historical performance
3. **Adjust thresholds**: Update `ENDPOINT_PERFORMANCE_BUDGETS` in `src/tests/helpers/performanceHelpers.ts`
4. **Document changes**: Update this file with rationale

Example threshold adjustment:

```typescript
const thresholds = getPerformanceBudget('transactions.combinedSortFilter', {
  maxResponseTime: 950, // tightened after observing stable CI p95
})
```

## Running Performance Tests

### Locally

Run all performance tests:

```bash
npm test -- --testPathPattern=performance
```

Run specific endpoint tests:

```bash
npm test -- src/tests/performance/vaults.perf.test.ts
npm test -- src/tests/performance/transactions.perf.test.ts
npm test -- src/tests/performance/analytics.perf.test.ts
```

### In CI

Performance tests run as part of the standard test suite:

```bash
npm test
```

To run only performance tests in CI:

```bash
npm test -- --testPathPattern=performance --maxWorkers=1
```

**Note**: Use `--maxWorkers=1` to avoid resource contention that could affect timing measurements.

## Test Infrastructure

### Helper Utilities

Located in `src/tests/helpers/performanceHelpers.ts`:

#### `measurePerformance(operation, thresholds)`

Measures response time for an async operation and validates against thresholds.

```typescript
const result = await measurePerformance(
  async () => {
    await request(app).get('/api/vaults').expect(200)
  },
  { maxResponseTime: 2000 }
)
```

#### `measureEndpointPerformance(db, operation, thresholds)`

Measures response time and counts Knex `query` events during the same operation.
Use this helper for list endpoints where `maxQueryCount` is part of the budget.

```typescript
const budget = getPerformanceBudget('transactions.cursorPagination')
const result = await measureEndpointPerformance(
  db,
  async () => {
    await request(app).get('/api/transactions?limit=20').expect(200)
  },
  budget,
)

assertPerformance(result, budget.label)
```

#### `assertIndexedPlan(plan, options)`

Parses PostgreSQL `EXPLAIN (FORMAT JSON)` output and fails when a representative
query uses `Seq Scan` unexpectedly or misses one of the configured indexes.

```typescript
const plan = await explainQueryPlan(
  db,
  'SELECT * FROM transactions WHERE type = ? ORDER BY stellar_timestamp DESC LIMIT 20',
  ['deposit'],
)

assertIndexedPlan(plan, {
  expectedIndexes: getPerformanceBudget('transactions.combinedSortFilter').expectedIndexes,
})
```

#### `seedLargeDataset(db, tableName, count, recordFactory)`

Efficiently seeds large datasets using batch inserts.

```typescript
await seedLargeDataset(
  db,
  'vaults',
  1000,
  (index) => generateTestVault(index, userId)
)
```

#### `generateTest*` Functions

Factory functions for creating realistic test data:
- `generateTestUser(index)`
- `generateTestVault(index, userId)`
- `generateTestTransaction(index, userId, vaultId)`

#### `cleanupPerfTestData(db)`

Removes all performance test data from the database.

```typescript
await cleanupPerfTestData(db)
```

#### `assertPerformance(result, testName)`

Throws an error if performance thresholds are violated.

```typescript
assertPerformance(result, 'vaults_list_no_pagination')
```

#### `logPerformanceMetrics(testName, result)`

Logs structured performance metrics for monitoring.

```typescript
logPerformanceMetrics('vaults_list_no_pagination', result)
```

### Test Coverage Requirements

All performance helper utilities must maintain **95% test coverage** minimum. This ensures:
- Reliable performance measurements
- Consistent test data generation
- Proper cleanup and error handling

To check coverage for performance helpers:

```bash
npm test -- --coverage --testPathPattern=performanceHelpers
```

## Database Indexes

Performance tests validate that appropriate indexes exist. Current indexes:

### Vaults Table

```sql
CREATE INDEX idx_vaults_creator_id ON vaults(creator_id);
CREATE INDEX idx_vaults_status ON vaults(status);
CREATE INDEX idx_vaults_end_date ON vaults(end_date);
```

### Transactions Table

```sql
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_vault_id ON transactions(vault_id);
CREATE INDEX idx_transactions_stellar_timestamp ON transactions(stellar_timestamp);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_cursor ON transactions(stellar_timestamp, id);
```

### Validating Indexes

To verify indexes are being used, check query plans:

```sql
EXPLAIN ANALYZE 
SELECT * FROM vaults 
WHERE creator_id = 'user-123' 
ORDER BY created_at DESC 
LIMIT 20;
```

Look for:
- ✅ `Index Scan` or `Index Only Scan`
- ❌ `Seq Scan` (full table scan - indicates missing index)

## Interpreting Results

### Successful Test Output

```
✓ Vaults list (no pagination): 245ms
✓ Vaults list (with pagination): 198ms
✓ Vaults list (with sorting): 267ms
```

### Failed Test Output

```
Performance test "vaults_list_no_pagination" failed: 
Response time 3456ms exceeded threshold 2000ms. 
Response time: 3456ms
```

### Performance Metrics Log

Tests emit structured JSON logs for monitoring:

```json
{
  "level": "info",
  "event": "performance.smoke_test",
  "test": "vaults_list_no_pagination",
  "responseTime": 245,
  "queryCount": 3,
  "passed": true,
  "violations": [],
  "timestamp": "2026-04-25T10:30:00.000Z"
}
```

## Troubleshooting

### Tests Timing Out

**Symptom**: Tests exceed Jest timeout (default 5s)

**Solutions**:
1. Increase timeout for seeding operations (already set to 60-120s)
2. Reduce dataset size for local development
3. Check database connection performance

### Flaky Tests

**Symptom**: Tests pass/fail inconsistently

**Solutions**:
1. Increase thresholds slightly (10-20%)
2. Run with `--maxWorkers=1` to avoid resource contention
3. Check for background processes affecting performance
4. Verify database is not under load from other tests

### Missing Indexes Detected

**Symptom**: Tests fail with high response times

**Solutions**:
1. Run `EXPLAIN ANALYZE` on failing queries
2. Add appropriate indexes to migrations
3. Update `docs/performance-testing.md` with new indexes
4. Re-run tests to validate improvement

### N+1 Query Problems

**Symptom**: Query count exceeds threshold

**Solutions**:
1. Enable query logging: `DEBUG=knex:query npm test`
2. Identify repeated queries
3. Use eager loading or joins to fetch related data
4. Add query count assertions to tests

## Adding New Performance Tests

### 1. Create Test File

```typescript
// src/tests/performance/newEndpoint.perf.test.ts
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import request from 'supertest'
import { app } from '../../app.js'
import { db } from '../../db/index.js'
import {
  measurePerformance,
  assertPerformance,
  logPerformanceMetrics
} from '../helpers/performanceHelpers.js'

describe('GET /api/new-endpoint - Performance Smoke Tests', () => {
  const thresholds = {
    maxResponseTime: 2000,
    maxQueryCount: 10
  }

  beforeAll(async () => {
    // Seed test data
  })

  afterAll(async () => {
    // Cleanup
    await db.destroy()
  })

  it('should respond within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        await request(app).get('/api/new-endpoint').expect(200)
      },
      thresholds
    )
    
    logPerformanceMetrics('new_endpoint', result)
    assertPerformance(result, 'new_endpoint')
  })
})
```

### 2. Update Documentation

Add the new endpoint to this document:
- Test coverage section
- Threshold table
- Index requirements (if applicable)

### 3. Validate Coverage

Ensure helper utilities maintain 95% coverage:

```bash
npm test -- --coverage --testPathPattern=performance
```

## CI Integration

### GitHub Actions Example

```yaml
name: Performance Tests

on: [push, pull_request]

jobs:
  performance:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run migrations
        run: npm run migrate:latest
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/disciplr_test
      
      - name: Run performance tests
        run: npm test -- --testPathPattern=performance --maxWorkers=1
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/disciplr_test
      
      - name: Upload performance metrics
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: performance-metrics
          path: performance-metrics.json
```

### Separate CI Job (Optional)

For faster feedback, run performance tests in a separate job:

```yaml
jobs:
  unit-tests:
    # Fast unit tests
    
  performance-tests:
    needs: unit-tests
    # Slower performance tests
```

## Monitoring and Alerting

### Metrics to Track

1. **Response Time Trends**: Track p50, p95, p99 over time
2. **Query Count**: Monitor for increases indicating N+1 problems
3. **Test Failure Rate**: Alert on consistent failures
4. **Dataset Size Impact**: Validate O(1) or O(log n) scaling

### Setting Up Monitoring

If using a monitoring service (Datadog, New Relic, etc.):

1. Parse structured JSON logs from tests
2. Create dashboards for response time trends
3. Set up alerts for threshold violations
4. Track performance across deployments

### Example Alert Rules

- **Warning**: Response time > 80% of threshold for 3 consecutive runs
- **Critical**: Response time > threshold or test failure
- **Info**: Response time increased > 20% compared to previous week

## Best Practices

### DO

✅ Use realistic data volumes (1k-10k records)
✅ Set conservative thresholds to avoid flakiness
✅ Clean up test data after each run
✅ Log structured metrics for monitoring
✅ Run with `--maxWorkers=1` in CI
✅ Document threshold changes with rationale
✅ Validate indexes with EXPLAIN ANALYZE

### DON'T

❌ Set overly tight thresholds that cause flakiness
❌ Test with unrealistic data volumes (too small or too large)
❌ Rely on external services (use mocks)
❌ Expose sensitive data in test logs
❌ Skip cleanup (causes test pollution)
❌ Ignore consistent failures (investigate root cause)

## Security Considerations

### Data Privacy

- Performance tests use synthetic data only
- No real user data is used
- Test data is clearly marked with prefixes (`perf-test-`, `vault-perf-`)
- All test data is cleaned up after execution

### Access Control

- Tests use test-specific API keys and user accounts
- API keys are created and destroyed within test lifecycle
- No production credentials are used

### Resource Limits

- Dataset sizes are bounded to prevent resource exhaustion
- Timeouts prevent runaway tests
- Cleanup ensures no data accumulation

## Future Improvements

### Planned Enhancements

1. **Query Count Tracking**: Implement actual query counting via Knex hooks
2. **Percentile Metrics**: Track p50, p95, p99 response times
3. **Regression Detection**: Automatically compare against baseline
4. **Visual Reports**: Generate HTML reports with charts
5. **Load Testing**: Add sustained load tests for production readiness

### Contributing

When adding performance tests:

1. Follow existing patterns in `src/tests/performance/`
2. Maintain 95% coverage for helper utilities
3. Document thresholds and rationale
4. Add indexes if needed
5. Update this documentation

## References

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Supertest Documentation](https://github.com/visionmedia/supertest)
- [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html)
- [Database Indexing Best Practices](https://use-the-index-luke.com/)

## Changelog

### 2026-04-25
- Initial performance testing infrastructure
- Added smoke tests for vaults, transactions, and analytics endpoints
- Documented thresholds and best practices
- Implemented helper utilities with 95% coverage requirement

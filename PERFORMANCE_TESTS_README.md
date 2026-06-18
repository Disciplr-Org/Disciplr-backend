# Performance Smoke Tests - Quick Start

## Prerequisites

1. **PostgreSQL Database Running**
   ```bash
   # Ensure your DATABASE_URL is set
   export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/disciplr_test"
   ```

2. **Dependencies Installed**
   ```bash
   npm install
   ```

3. **Migrations Applied**
   ```bash
   npm run migrate:latest
   ```

## Running Tests

### Run All Performance Tests
```bash
npm run test:perf
```

### Run Specific Endpoint Tests
```bash
# Vaults endpoint
npm test -- src/tests/performance/vaults.perf.test.ts

# Transactions endpoint
npm test -- src/tests/performance/transactions.perf.test.ts

# Analytics endpoints
npm test -- src/tests/performance/analytics.perf.test.ts
```

### Run Helper Utility Tests
```bash
npm test -- src/tests/helpers/performanceHelpers.test.ts
```

## Expected Output

### Successful Test Run
```
✓ Vaults list (no pagination): 245ms
✓ Vaults list (with pagination): 198ms
✓ Vaults list (with sorting): 267ms
✓ Vaults list (with filtering): 223ms
✓ Vaults list (combined operations): 289ms

✓ Transactions list (first page): 312ms
✓ Transactions list (cursor pagination): 298ms
✓ Transactions list (with filter): 334ms
✓ Transactions list (date range filter): 356ms
✓ Transactions list (by vault): 287ms
✓ Transactions deep pagination (10 pages): 2145ms

✓ Analytics summary: 45ms
✓ Analytics overview: 38ms
✓ Analytics vaults: 42ms
✓ Analytics vault-specific: 41ms
✓ Analytics milestone trends: 156ms
✓ Analytics behavior: 134ms
✓ Analytics milestone trends (weekly): 178ms
```

### Failed Test (Threshold Violation)
```
Performance test "vaults_list_no_pagination" failed: 
Response time 3456ms exceeded threshold 2000ms. 
Response time: 3456ms
```

## Understanding Results

### Response Times
- **< 500ms**: Excellent
- **500-1000ms**: Good
- **1000-2000ms**: Acceptable (within threshold)
- **> 2000ms**: Needs investigation

### Common Issues

#### Database Not Running
```
Error: Unable to acquire a connection
```
**Solution**: Start PostgreSQL and verify DATABASE_URL

#### Migrations Not Applied
```
Error: relation "vaults" does not exist
```
**Solution**: Run `npm run migrate:latest`

#### Slow Performance
```
Response time 3456ms exceeded threshold 2000ms
```
**Solution**: 
1. Check database indexes with `EXPLAIN (ANALYZE, FORMAT JSON)`
2. Review query patterns for N+1 problems
3. Consider adjusting thresholds if environment is consistently slower

## Tuning Thresholds

If tests are consistently failing or passing with too much margin:

1. **Edit the shared budget table** in `src/tests/helpers/performanceHelpers.ts`
2. **Adjust the named endpoint budget**:
   ```typescript
   const thresholds = getPerformanceBudget('transactions.filteredByType')
   ```
3. **Document changes** in `docs/performance-testing.md`

## Monitoring in Production

Performance tests emit structured JSON logs:

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

Use these logs to:
- Track performance trends over time
- Set up alerts for threshold violations
- Identify performance regressions in CI

## Validating Indexes

To verify indexes are being used manually or with `assertIndexedQueryPlan()`:

```sql
EXPLAIN (ANALYZE, FORMAT JSON)
SELECT * FROM vaults 
WHERE status = 'active'
ORDER BY end_date DESC
LIMIT 20;
```

Look for:
- ✅ `Index Scan` or `Index Only Scan`
- ❌ `Seq Scan` (indicates missing index)

## CI Integration

Tests run automatically in CI:

```yaml
- name: Run performance smoke tests
  run: npm run test:perf
  env:
    NODE_ENV: test
```

## Troubleshooting

### Tests Timing Out
- Increase Jest timeout in test files
- Reduce dataset size for local development
- Check database connection performance

### Flaky Tests
- Run with `--maxWorkers=1` to avoid resource contention
- Increase thresholds by 10-20%
- Check for background processes affecting performance

### Memory Issues
- Reduce dataset sizes in test files
- Ensure proper cleanup in `afterAll` hooks
- Check for memory leaks in application code

## Further Reading

See `docs/performance-testing.md` for:
- Detailed architecture
- Best practices
- Security considerations
- Adding new performance tests
- Advanced troubleshooting

## Quick Reference

| Command | Purpose |
|---------|---------|
| `npm run test:perf` | Run all performance tests |
| `npm test -- --testPathPattern=performance` | Alternative way to run perf tests |
| `npm run migrate:latest` | Apply database migrations |
| `npm run migrate:status` | Check migration status |

## Support

For issues or questions:
1. Check `docs/performance-testing.md`
2. Review test output and logs
3. Validate database indexes
4. Check CI logs for environment-specific issues

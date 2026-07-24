# Database Testing Guide

This document outlines the standardized approach for database testing in the Disciplr backend.

## Test Harness

We use a centralized test harness located at `src/tests/helpers/testDatabase.ts`. This harness provides utilities for both **Prisma** and **Knex** integration testing.

### Core Features

- **Clean State**: Each test suite is responsible for ensuring a clean state using `truncateTables` or `setupTestDatabase`.
- **Security Guards**: The harness prevents execution against production databases by validating the `DATABASE_URL` and `NODE_ENV`.
- **Hybrid Support**: Seamlessly manages both Prisma and Knex instances in the same harness.
- **Graceful Skipping**: Integration tests automatically skip if a live database connection is not available, allowing CI to run unit tests without infra overhead.

## Usage

### 1. Basic Setup

In your test suite, import the harness utilities:

```typescript
import { setupTestDatabase, teardownTestDatabase, truncateTables, TestHarness } from './helpers/testDatabase.js'

describe('My Service Integration', () => {
  let harness: TestHarness

  beforeAll(async () => {
    // Initializes Knex and Prisma
    harness = await setupTestDatabase()
  })

  afterAll(async () => {
    // Closes connections
    await teardownTestDatabase(harness)
  })

  beforeEach(async () => {
    // Cleans all tables for isolation
    await truncateTables(harness.knex)
  })

  it('should save data', async () => {
    await harness.knex('users').insert({ ... })
    const user = await harness.prisma.user.findUnique({ ... })
    expect(user).toBeDefined()
  })
})
```

### 2. Parallel Execution

**Parallel execution is currently disabled** (via recommended `--runInBand` flag) because tests share a single PostgreSQL database. 

**Rationale**: To support safe parallel execution, we would need to dynamically create and drop test databases (e.g., `disciplr_test_worker_1`), which increases test setup complexity and latency. For current repository scale, `--runInBand` ensures maximum reliability and simplified debugging.

## Security Guard Rails

The harness includes strict checks to prevent accidental data loss:
- Refuses to run if `NODE_ENV=production`.
- Refuses to run if `DATABASE_URL` does not contain `localhost`, `127.0.0.1`, or the word `test`.

## Environment Configuration

Integration tests require a running PostgreSQL instance. Configure it via environment variables:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/disciplr_test
```

If the database is unreachable, integration tests will log `SKIP: no database available` and pass, while unit tests will continue to execute.

## Best Practices

1. **Prefer Truncate over Migrate**: `truncateTables` is significantly faster than running `migrateDown`/`migrateUp` between tests.
2. **Use Fixture Helpers**: Use `seedMinimalFixtures(harness)` to populate standard reference data (like RBAC roles).
3. **Snapshot Comparison**: Use `captureDbState(db)` and `compareDbStates(s1, s2)` to verify idempotency or complex multi-table transactions.

## Transpiler & Test Runner Setup

The testing harness executes exclusively using **`ts-jest`** for unit and integration testing, and **`tsx`** for script execution.

### Transpiler Standardization
Historically, both `ts-node` and `tsx` coexisted in the codebase, leading to subtle ESM semantics mismatch flakiness in CI. To solve this:
- `ts-node` has been completely removed from the project dependencies and Jest configurations.
- All Jest test suites are run via `ts-jest` under `--experimental-vm-modules` ESM execution, using the optimized `tsconfig.jest.json` config.
- One-off scripts and router tests are run via `tsx`.
- Direct imports of `ts-node` are banned by ESLint (`no-restricted-imports`).

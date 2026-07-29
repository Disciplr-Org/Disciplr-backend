# Production Database Migration Strategy Runbook

This operational runbook establishes standards for zero-downtime, safe online schema migrations on PostgreSQL within the Disciplr backend codebase.

It complements the baseline migration documentation found in [database-migrations.md](../database-migrations.md).

---

## 1. Overview & Operational Principles

When operating live PostgreSQL databases under production traffic, direct schema modifications (such as column renames, type alterations, column removals, or synchronous indexing) can introduce heavy table locks, leading to blocked application transactions, connection pool exhaustion, and outages.

To ensure zero downtime:
- All breaking schema changes must follow the **Expand/Contract (Additive-Then-Cleanup)** pattern.
- Indexes on live or large tables must use **`CREATE INDEX CONCURRENTLY`**.
- Data backfills must be **lock-aware** and batched with **`statement_timeout` guardrails**.
- Every migration must strictly maintain a verified, bi-directional rollback round-trip using `npm run migrate:rollback`.

---

## 2. Zero-Downtime Expand/Contract Pattern (Additive-Then-Cleanup)

When making breaking schema changes (renaming columns, removing columns, altering data types, or changing constraints), executing the change in a single migration causes immediate application failures or requires downtime.

Instead, breaking schema changes must be deployed across multiple releases using the **Expand/Contract** pattern.

### Phase 1: Expand (Additive Schema Migration)
1. **Apply Additive Migration**: Create the new column or table alongside the legacy schema. Keep old columns intact and nullable (or with default values).
2. **Deploy Application Code (Dual Writing / Fallback Reading)**: Update application code to write to both old and new columns, and read from the new column with fallback to the old column if NULL.

### Phase 2: Lock-Aware Backfill
1. **Backfill Historical Data**: Run a background script or asynchronous migration job to copy missing historical data from the old column to the new column in small, controlled batches.
2. **Verify Data Parity**: Confirm that all active rows have populated values in the new column.

### Phase 3: Contract (Cleanup Migration)
1. **Deploy New Reader Code**: Update application code to read exclusively from the new column and stop writing to the old column.
2. **Apply Cleanup Migration**: In a subsequent release, drop the legacy column, constraints, or tables (`exports.up`), and restore them in rollback (`exports.down`).

---

## 3. Concurrent Indexing (`CREATE INDEX CONCURRENTLY`)

### Why Plain Index Creation Locks
A standard `CREATE INDEX` statement acquires a `SHARE` lock on the target table. While `SELECT` queries can continue, all write operations (`INSERT`, `UPDATE`, `DELETE`) are strictly blocked until index build completes. On tables with millions of rows or high transaction velocity, this causes connection pool queuing and cascading failures.

### Using `CREATE INDEX CONCURRENTLY` in Knex
To create an index without blocking concurrent writes, use `CREATE INDEX CONCURRENTLY`. In PostgreSQL, `CREATE INDEX CONCURRENTLY` scans the table twice and waits for existing transactions to terminate.

Because PostgreSQL prohibits `CREATE INDEX CONCURRENTLY` inside a transaction block, you must explicitly disable Knex's default transaction wrapping by exporting `config = { transaction: false }` in your migration file.

Example (`db/migrations/20260301000000_add_concurrent_index.cjs`):
```javascript
exports.config = { transaction: false };

exports.up = async function(knex) {
  await knex.raw('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vaults_creator_status ON vaults (creator, status);');
};

exports.down = async function(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF NOT EXISTS idx_vaults_creator_status;');
};
```

### Handling Invalid Indexes
If a concurrent index creation is cancelled or fails (e.g., due to a unique constraint violation or deadlock), PostgreSQL leaves an `INVALID` index in the database.
- Check for invalid indexes: `SELECT relname FROM pg_class c JOIN pg_index i ON c.oid = i.indexrelid WHERE NOT i.indisvalid;`
- Clean up invalid indexes using `DROP INDEX CONCURRENTLY <index_name>` before re-running the migration.

---

## 4. Lock Guardrails & Backfills

### Statement Timeouts
To prevent a migration from acquiring long wait locks and blocking incoming traffic, configure explicit statement timeouts.
```javascript
exports.up = async function(knex) {
  await knex.raw('SET local statement_timeout = \'5000ms\';');
  // run migration logic
};
```

### Batch Backfills
When backfilling data across large tables:
- Never execute a single unbounded `UPDATE table SET new_col = old_col;`.
- Use ID-range or primary key chunking (e.g., updating batches of 1,000 to 5,000 rows).
- Introduce brief sleep/pause delays between batches to allow application transactions to proceed without lock contention.

---

## 5. Rollback Discipline & Round-Trip Verification

### Strict Dual-Direction Requirement
Every migration file in `db/migrations/*.cjs` must export both an `up` and a `down` function.
- `exports.up`: Applies schema additions, modifications, or index creations.
- `exports.down`: Completely reverses every change made in `exports.up` in reverse order.

### Verification Workflow
Before merging any database migration PR, developers must verify the rollback round-trip locally or in staging:
1. Apply pending migrations:
   ```bash
   npm run migrate:latest
   ```
2. Verify migration status:
   ```bash
   npm run migrate:status
   ```
3. Roll back the batch to verify clean reversal:
   ```bash
   npm run migrate:rollback
   ```
4. Re-apply to leave the database in the target state:
   ```bash
   npm run migrate:latest
   ```

---

## 6. Repository Conventions & Workflows

All database migrations in Disciplr follow standard conventions managed via Knex:
- **Location**: `db/migrations/*.cjs`
- **CLI Commands**:
  - `npm run migrate:make <migration_name>`: Generate a new migration skeleton.
  - `npm run migrate:latest`: Apply all pending migrations.
  - `npm run migrate:status`: Inspect applied and pending migration status.
  - `npm run migrate:rollback`: Roll back the most recent migration batch.

Related documentation:
- Baseline configuration and historical migration context: [database-migrations.md](../database-migrations.md).

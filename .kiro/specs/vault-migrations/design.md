# Design Document: vault-migrations

## Overview

This design covers a single corrective Knex migration that closes the schema drift between the existing `db/migrations/` files and the `PersistedVault` / `PersistedMilestone` TypeScript interfaces consumed by `vaultStore.ts`. It also aligns `prisma/schema.prisma`, adds a Jest test suite with ≥ 95% coverage, and updates `docs/database-migrations.md`.

No new tables are introduced. All changes are additive or rename-based, keeping the migration reversible.

---

## Architecture

```
db/migrations/
  20260225190000_initial_baseline.cjs        ← existing (vaults table, vault_status enum)
  20260225200000_create_milestones.cjs       ← existing (milestones v1 — conflicts with v2)
  20260226014238_create_milestones_table.cjs ← existing (milestones v2 — conflicts with v1)
  20260227000000_fix_vault_schema.cjs        ← NEW corrective migration

prisma/schema.prisma                         ← updated Vault model + VaultStatus enum

tests/migrations/
  vault-schema.migration.test.ts             ← NEW Jest test suite

docs/database-migrations.md                 ← updated
```

The corrective migration runs after all existing migrations. It does not touch migrations that have already been merged; instead it applies forward-only DDL changes and provides a complete `down` path.

---

## Components and Interfaces

### 1. Corrective Migration — `20260227000000_fix_vault_schema.cjs`

Responsible for all DDL changes to bring the live schema in line with `vaultStore.ts`.

**`exports.up(knex)`**

Steps (all within a single `knex.transaction` block):

1. Log `{ migration: 'fix_vault_schema', step: 'rename start_timestamp → start_date', status: 'start' }`
2. `ALTER TABLE vaults RENAME COLUMN start_timestamp TO start_date`
3. `ALTER TABLE vaults RENAME COLUMN end_timestamp TO end_date`
4. Add `verifier VARCHAR(255) NOT NULL DEFAULT ''` then remove the default (two-step for NOT NULL on existing rows)
5. Add `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
6. Drop index `idx_vaults_end_timestamp`; create `idx_vaults_end_date`
7. Add `'draft'` to the `vault_status` enum via `ALTER TYPE vault_status ADD VALUE IF NOT EXISTS 'draft'`
8. `ALTER TABLE vaults ALTER COLUMN status SET DEFAULT 'draft'`
9. Resolve milestones conflict: if the `milestones` table is missing `sort_order` or `amount` columns (from the v2 schema winning), add them; if it is missing `type`/`criteria`/`weight` (from the v1 schema winning), add them as nullable to avoid breaking existing rows.
10. Log each step completion.

> Note: `ALTER TYPE … ADD VALUE` cannot run inside a transaction in PostgreSQL < 12. The migration detects the PG version and either uses a transaction (PG ≥ 12) or runs the enum alteration outside the transaction with a compensating rollback guard.

**`exports.down(knex)`**

Steps (reverse order, within a transaction where possible):

1. Guard: if any vault row has `status = 'draft'`, update those rows to `'active'` before removing the enum value (logged, not silently dropped).
2. `ALTER TABLE vaults ALTER COLUMN status SET DEFAULT 'active'`
3. Remove `'draft'` from `vault_status` — done via the standard PostgreSQL workaround: create a new enum without `'draft'`, cast the column, drop the old type, rename the new type.
4. Drop `idx_vaults_end_date`; recreate `idx_vaults_end_timestamp`
5. Drop `updated_at` column
6. Drop `verifier` column
7. `ALTER TABLE vaults RENAME COLUMN end_date TO end_timestamp`
8. `ALTER TABLE vaults RENAME COLUMN start_date TO start_timestamp`
9. Revert any milestones columns added in `up`.

### 2. Prisma Schema Updates — `prisma/schema.prisma`

```prisma
enum VaultStatus {
  DRAFT
  ACTIVE
  COMPLETED
  FAILED
  CANCELLED
}

model Vault {
  id                 String      @id @default(uuid())
  creatorId          String
  creator            User        @relation(fields: [creatorId], references: [id])
  amount             String
  startDate          DateTime    @default(now()) @map("start_date")
  endDate            DateTime    @map("end_date")
  verifier           String
  successDestination String      @map("success_destination")
  failureDestination String      @map("failure_destination")
  status             VaultStatus @default(DRAFT)
  createdAt          DateTime    @default(now()) @map("created_at")
  updatedAt          DateTime    @updatedAt @map("updated_at")

  @@index([creatorId])
  @@index([status])
  @@index([endDate])
}
```

### 3. Test Suite — `tests/migrations/vault-schema.migration.test.ts`

Uses a real PostgreSQL connection (via `DATABASE_URL` pointing to a test database) or a transaction-scoped wrapper that rolls back after each test. The suite imports the migration file directly and calls `up`/`down` programmatically via a Knex instance.

---

## Data Models

### `vaults` table — before vs. after

| Column | Before | After |
|---|---|---|
| `id` | `VARCHAR(64) PK` | unchanged |
| `creator` | `VARCHAR(255) NOT NULL` | unchanged |
| `amount` | `DECIMAL(36,7) NOT NULL` | unchanged |
| `start_timestamp` | `TIMESTAMPTZ NOT NULL` | renamed → `start_date` |
| `end_timestamp` | `TIMESTAMPTZ NOT NULL` | renamed → `end_date` |
| `success_destination` | `VARCHAR(255) NOT NULL` | unchanged |
| `failure_destination` | `VARCHAR(255) NOT NULL` | unchanged |
| `status` | enum(`active`,`completed`,`failed`,`cancelled`) default `active` | enum adds `draft`, default → `draft` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | unchanged |
| `verifier` | — | `VARCHAR(255) NOT NULL` added |
| `updated_at` | — | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` added |
| `user_id` | `UUID nullable FK → users` | unchanged |

### `milestones` table — canonical columns required by `vaultStore.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | `VARCHAR(64) PK` | |
| `vault_id` | `VARCHAR(64) NOT NULL FK → vaults.id` | CASCADE DELETE |
| `title` | `VARCHAR(255) NOT NULL` | |
| `description` | `TEXT nullable` | |
| `due_date` | `TIMESTAMPTZ NOT NULL` | |
| `amount` | `DECIMAL(36,7) NOT NULL` | |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Property 1: Column set round-trip
*For any* clean database, applying `exports.up` then `exports.down` should leave the `vaults` table with exactly the same column names it had before `exports.up` ran.
**Validates: Requirements 1.7, 1.8, 1.9, 1.10, 5.1**

Property 2: Draft status insert succeeds after up
*For any* valid vault payload, after `exports.up` is applied, inserting a row with `status = 'draft'` using the `vaultStore.ts` column list should succeed and the row should be retrievable with `status = 'draft'`.
**Validates: Requirements 1.5, 1.6, 6.3, 6.4**

Property 3: vaultStore column list compatibility
*For any* vault INSERT using the exact column list `(id, amount, start_date, end_date, verifier, success_destination, failure_destination, creator, status)`, after `exports.up` the INSERT should succeed without a column-not-found error.
**Validates: Requirements 1.1, 1.2, 1.3, 6.4**

Property 4: Rollback draft-row guard
*For any* database state where one or more vault rows have `status = 'draft'`, executing `exports.down` should not silently delete or corrupt those rows — it should either migrate them to a valid pre-migration status or raise a descriptive error.
**Validates: Requirements 5.4, 6.5**

Property 5: Index consistency after up and down
*For any* migration cycle (up then down), the set of index names on the `vaults` table should be identical before and after the cycle.
**Validates: Requirements 2.1, 2.2, 2.3**

Property 6: Log entries contain no PII
*For any* migration execution, every log entry emitted by the migration should not contain wallet address strings (i.e., strings matching the Stellar address pattern `G[A-Z2-7]{55}`).
**Validates: Requirements 7.4**

---

## Error Handling

| Scenario | Handling |
|---|---|
| `exports.up` fails mid-transaction | Transaction rolls back; database left in pre-migration state |
| `ALTER TYPE ADD VALUE` outside transaction (PG < 12) | Migration detects version; if subsequent steps fail, a compensating `ALTER TYPE … RENAME` is attempted and the error is re-thrown |
| `exports.down` with existing `'draft'` rows | Rows are updated to `'active'` with a warning log before enum alteration; if the update fails, the rollback aborts with a descriptive error |
| Missing `DATABASE_URL` in tests | Test suite skips database tests with a clear `console.warn` and marks them as pending |
| Duplicate milestones table definitions | Migration inspects `information_schema.columns` before adding columns; uses `IF NOT EXISTS` guards where Knex supports them |

---

## Testing Strategy

### Dual Testing Approach

Both unit tests and property-based tests are used:

- **Unit tests** cover specific examples, edge cases, and error conditions (e.g., rollback with draft rows, missing columns before migration).
- **Property-based tests** verify universal properties across generated inputs (e.g., any valid vault payload can be inserted after migration).

### Property-Based Testing Library

Use **`fast-check`** (already compatible with Jest + TypeScript). Each property test runs a minimum of **100 iterations**.

Tag format for each property test:
`// Feature: vault-migrations, Property N: <property_text>`

### Test File: `tests/migrations/vault-schema.migration.test.ts`

**Unit tests:**
- `up` adds `verifier` and `updated_at` columns
- `up` renames `start_timestamp` → `start_date` and `end_timestamp` → `end_date`
- `up` adds `'draft'` to `vault_status` enum
- `up` changes default status to `'draft'`
- `down` after `up` restores original column names
- `down` after `up` removes `verifier` and `updated_at`
- `down` migrates `'draft'` rows to `'active'` before removing enum value
- INSERT with `vaultStore.ts` column list succeeds after `up`
- INSERT with `status = 'draft'` succeeds after `up`

**Property tests (fast-check):**
- Property 1: Column set round-trip (generate random vault rows, apply up/down, verify column names)
- Property 2: Draft status insert succeeds after up (generate random vault payloads)
- Property 3: vaultStore column list compatibility (generate random valid vault data)
- Property 4: Rollback draft-row guard (generate databases with N draft rows, verify down handles them)
- Property 5: Index consistency after up and down
- Property 6: Log entries contain no PII (generate vault data with Stellar-like addresses, verify log output)

### Coverage Target

≥ 95% line coverage on `db/migrations/20260227000000_fix_vault_schema.cjs` and any helper modules.

# Requirements Document

## Introduction

The `vault-migrations` feature corrects schema drift between the existing Knex migration files and the `PersistedVault` / `PersistedMilestone` TypeScript interfaces used by `vaultStore.ts`. The work involves authoring a new corrective Knex migration, aligning the Prisma schema, and adding a comprehensive Jest test suite that covers the migration's `up` and `down` paths, rollback safety, and data-integrity invariants — all without leaking PII in logs or metrics.

## Glossary

- **Migration**: A Knex `.cjs` file in `db/migrations/` with `exports.up` and `exports.down` functions that alter the PostgreSQL schema.
- **Rollback**: Executing `exports.down` to reverse a migration batch.
- **PersistedVault**: The TypeScript interface in `src/types/vaults.ts` that represents a vault row as returned to callers.
- **PersistedMilestone**: The TypeScript interface in `src/types/vaults.ts` that represents a milestone row as returned to callers.
- **vaultStore**: The module `src/services/vaultStore.ts` that issues raw SQL against the `vaults` and `milestones` tables.
- **vault_status**: The PostgreSQL native enum type used for the `status` column on the `vaults` table.
- **Knex**: The query-builder and migration runner configured in `knexfile.cjs`.
- **Prisma**: The ORM whose schema lives in `prisma/schema.prisma` and must stay consistent with the Knex-managed schema.
- **PII**: Personally Identifiable Information — wallet addresses (`creator`, `verifier`, `success_destination`, `failure_destination`) must not appear in plain-text logs.

---

## Requirements

### Requirement 1: Corrective Vault Migration — Column Alignment

**User Story:** As a backend developer, I want the `vaults` table columns to match the names and types that `vaultStore.ts` uses in its SQL queries, so that INSERT and SELECT statements execute without column-not-found errors.

#### Acceptance Criteria

1. WHEN the Migration is applied, THE Migration SHALL rename the `start_timestamp` column to `start_date` on the `vaults` table.
2. WHEN the Migration is applied, THE Migration SHALL rename the `end_timestamp` column to `end_date` on the `vaults` table.
3. WHEN the Migration is applied, THE Migration SHALL add a `verifier` column of type `VARCHAR(255) NOT NULL` to the `vaults` table.
4. WHEN the Migration is applied, THE Migration SHALL add an `updated_at` column of type `TIMESTAMP WITH TIME ZONE NOT NULL` defaulting to `NOW()` to the `vaults` table.
5. WHEN the Migration is applied, THE Migration SHALL update the `vault_status` native enum to include the `'draft'` value in addition to the existing `'active'`, `'completed'`, `'failed'`, and `'cancelled'` values.
6. WHEN the Migration is applied, THE Migration SHALL update the default value of the `status` column from `'active'` to `'draft'`.
7. WHEN the Migration is rolled back, THE Migration SHALL restore the `start_date` column name to `start_timestamp`.
8. WHEN the Migration is rolled back, THE Migration SHALL restore the `end_date` column name to `end_timestamp`.
9. WHEN the Migration is rolled back, THE Migration SHALL drop the `verifier` column from the `vaults` table.
10. WHEN the Migration is rolled back, THE Migration SHALL drop the `updated_at` column from the `vaults` table.
11. WHEN the Migration is rolled back, THE Migration SHALL remove the `'draft'` value from the `vault_status` enum and restore the default to `'active'`.

### Requirement 2: Corrective Vault Migration — Index Alignment

**User Story:** As a backend developer, I want the indexes on the `vaults` table to reference the correct column names after the rename, so that query plans remain valid.

#### Acceptance Criteria

1. WHEN the Migration is applied, THE Migration SHALL drop the existing index `idx_vaults_end_timestamp` that references the old `end_timestamp` column.
2. WHEN the Migration is applied, THE Migration SHALL create a new index `idx_vaults_end_date` on the renamed `end_date` column.
3. WHEN the Migration is rolled back, THE Migration SHALL drop `idx_vaults_end_date` and recreate `idx_vaults_end_timestamp` on the restored `end_timestamp` column.

### Requirement 3: Milestones Table Alignment

**User Story:** As a backend developer, I want the `milestones` table to match the columns that `vaultStore.ts` uses in its INSERT and SELECT queries, so that milestone persistence works correctly.

#### Acceptance Criteria

1. THE Migration SHALL ensure the `milestones` table contains columns: `id`, `vault_id`, `title`, `description`, `due_date`, `amount`, `sort_order`, and `created_at` with types compatible with `PersistedMilestone`.
2. WHEN the `milestones` table already contains conflicting duplicate definitions from earlier migrations (e.g., `20260225200000_create_milestones.cjs` and `20260226014238_create_milestones_table.cjs`), THE Migration SHALL resolve the conflict so exactly one canonical `milestones` table definition exists.
3. WHEN the Migration is rolled back, THE Migration SHALL restore the `milestones` table to its pre-migration state without data loss beyond what was added by the migration.

### Requirement 4: Prisma Schema Consistency

**User Story:** As a backend developer, I want the Prisma schema to reflect the corrected column names and enum values, so that Prisma-generated types and queries remain consistent with the live database.

#### Acceptance Criteria

1. WHEN the corrective migration is applied, THE Prisma_Schema SHALL be updated to rename `startTimestamp` / `endTimestamp` fields to `startDate` / `endDate` with the corresponding `@map` directives pointing to `start_date` / `end_date`.
2. WHEN the corrective migration is applied, THE Prisma_Schema SHALL add a `verifier` field of type `String` to the `Vault` model.
3. WHEN the corrective migration is applied, THE Prisma_Schema SHALL add an `updatedAt` field with `@updatedAt` to the `Vault` model.
4. WHEN the corrective migration is applied, THE Prisma_Schema SHALL add `DRAFT` to the `VaultStatus` enum.
5. THE Prisma_Schema SHALL use `@@map` or `@map` annotations so that Prisma field names match the TypeScript camelCase convention while database column names remain snake_case.

### Requirement 5: Rollback Safety

**User Story:** As a backend developer, I want every migration to have a tested rollback path, so that I can safely revert a bad deploy without manual database surgery.

#### Acceptance Criteria

1. WHEN `exports.down` is executed after `exports.up`, THE Migration SHALL leave the `vaults` table in the same schema state it was in before `exports.up` ran.
2. WHEN `exports.down` is executed after `exports.up`, THE Migration SHALL leave the `milestones` table in the same schema state it was in before `exports.up` ran.
3. IF `exports.up` fails partway through, THEN THE Migration SHALL not leave the database in a partially-migrated state (all DDL changes within a single migration MUST be wrapped in a transaction where PostgreSQL supports transactional DDL).
4. WHEN `exports.down` is executed on a database that has rows with `status = 'draft'`, THEN THE Migration SHALL either migrate those rows to a compatible status or raise a descriptive error before altering the enum, preventing silent data corruption.

### Requirement 6: Test Coverage

**User Story:** As a backend developer, I want a Jest test suite that exercises the migration's up and down paths against a real (or in-process) database, so that regressions are caught automatically in CI.

#### Acceptance Criteria

1. THE Test_Suite SHALL include tests that run `exports.up` against a clean schema and assert that all new/renamed columns exist on the `vaults` table.
2. THE Test_Suite SHALL include tests that run `exports.down` after `exports.up` and assert that the `vaults` table is restored to its pre-migration column set.
3. THE Test_Suite SHALL include a test that inserts a vault row with `status = 'draft'` after `exports.up` and asserts the row is retrievable with the correct status.
4. THE Test_Suite SHALL include a test that verifies a vault INSERT using the exact column list from `vaultStore.ts` (`id`, `amount`, `start_date`, `end_date`, `verifier`, `success_destination`, `failure_destination`, `creator`, `status`) succeeds after the migration is applied.
5. THE Test_Suite SHALL include a test that verifies the rollback path handles existing `'draft'` rows without silent data loss.
6. THE Test_Suite SHALL achieve ≥ 95% line coverage on the new migration file and any helper modules introduced by this feature.
7. WHEN tests run, THE Test_Suite SHALL use a dedicated test database or transaction-scoped isolation so that tests do not affect the development database.

### Requirement 7: Observability Without PII Leakage

**User Story:** As a backend developer, I want migration execution to emit structured log entries so that I can observe migration progress in CI and production, without exposing wallet addresses or other PII in log output.

#### Acceptance Criteria

1. WHEN a migration step starts, THE Migration SHALL emit a log entry containing the migration name and step description (e.g., `"renaming column start_timestamp → start_date"`).
2. WHEN a migration step completes successfully, THE Migration SHALL emit a log entry with the step name and a `"success"` status.
3. IF a migration step fails, THEN THE Migration SHALL emit a log entry with the step name, a `"failure"` status, and the error message — without including row data that may contain PII.
4. THE Migration SHALL NOT log column values from vault rows (wallet addresses, amounts, destinations) at any log level.
5. WHERE a structured logger (e.g., `console.log` with JSON shape) is already used in the project, THE Migration SHALL use the same logging pattern for consistency.

### Requirement 8: Documentation Update

**User Story:** As a backend developer, I want the existing migration documentation updated to reflect the new corrective migration, so that the team understands the schema history.

#### Acceptance Criteria

1. WHEN the corrective migration is merged, THE Documentation in `docs/database-migrations.md` SHALL be updated to describe the new migration file, the columns it adds/renames, and the enum change.
2. THE Documentation SHALL note the rollback procedure specific to the `'draft'` status rows.
3. THE Documentation SHALL NOT introduce new markdown files outside of `docs/`.

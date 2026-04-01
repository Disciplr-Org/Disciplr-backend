# Implementation Plan: vault-migrations

## Overview

Implement a corrective Knex migration that closes schema drift between `db/migrations/` and `PersistedVault`/`PersistedMilestone`, align `prisma/schema.prisma`, add a Jest + fast-check test suite with ≥ 95% coverage, and update `docs/database-migrations.md`.

## Tasks

- [x] 1. Author the corrective Knex migration file
  - Create `db/migrations/20260227000000_fix_vault_schema.cjs`
  - Implement `exports.up`:
    - Wrap all DDL in a `knex.transaction` (or handle PG < 12 enum caveat outside transaction with a guard)
    - Rename `start_timestamp` → `start_date` and `end_timestamp` → `end_date`
    - Add `verifier VARCHAR(255) NOT NULL DEFAULT ''`, then drop the default
    - Add `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    - Drop index `idx_vaults_end_timestamp`; create `idx_vaults_end_date` on `end_date`
    - `ALTER TYPE vault_status ADD VALUE IF NOT EXISTS 'draft'`
    - `ALTER TABLE vaults ALTER COLUMN status SET DEFAULT 'draft'`
    - Inspect `information_schema.columns` and add any missing milestones columns (`sort_order`, `amount`) using `IF NOT EXISTS` guards
    - Emit structured log entries (step name + status) at each step — no row values in logs
  - Implement `exports.down`:
    - Guard: UPDATE rows with `status = 'draft'` to `'active'` with a warning log before enum alteration
    - Restore `status` default to `'active'`
    - Remove `'draft'` from `vault_status` via create-new-enum / cast / drop-old / rename pattern
    - Drop `idx_vaults_end_date`; recreate `idx_vaults_end_timestamp`
    - Drop `updated_at` and `verifier` columns
    - Rename `end_date` → `end_timestamp` and `start_date` → `start_timestamp`
    - Revert any milestones columns added in `up`
  - _Requirements: 1.1–1.11, 2.1–2.3, 3.1–3.3, 5.1–5.4, 7.1–7.5_

- [x] 2. Write tests for the corrective migration
  - Create `tests/migrations/vault-schema.migration.test.ts`
  - Set up a Knex test instance pointing at `DATABASE_URL` (skip with `test.skip` + `console.warn` if not set)
  - Use `beforeEach`/`afterEach` to run `down` (if applied) and `up` / `down` to isolate each test

  - [x] 2.1 Write unit tests for `exports.up` column changes
    - Assert `start_date` and `end_date` exist; `start_timestamp` and `end_timestamp` do not
    - Assert `verifier` and `updated_at` columns exist
    - Assert INSERT with `vaultStore.ts` column list `(id, amount, start_date, end_date, verifier, success_destination, failure_destination, creator, status)` succeeds
    - Assert INSERT with `status = 'draft'` succeeds and row is retrievable
    - Assert default status on INSERT without explicit status is `'draft'`
    - _Requirements: 1.1–1.6, 6.1, 6.3, 6.4_

  - [x] 2.2 Write unit tests for `exports.down` rollback
    - Assert `start_timestamp` and `end_timestamp` are restored; `start_date` and `end_date` are gone
    - Assert `verifier` and `updated_at` columns are removed
    - Assert INSERT with `status = 'draft'` fails after rollback (enum value removed)
    - _Requirements: 1.7–1.11, 5.1, 6.2_

  - [ ]* 2.3 Write property test — Property 1: Column set round-trip
    - **Property 1: Column set round-trip**
    - **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 5.1**
    - Use fast-check to generate random sequences of up/down cycles and assert column names are identical before and after each cycle
    - `// Feature: vault-migrations, Property 1: column set round-trip`

  - [ ]* 2.4 Write property test — Property 2: Draft status insert succeeds after up
    - **Property 2: Draft status insert succeeds after up**
    - **Validates: Requirements 1.5, 1.6, 6.3, 6.4**
    - Use fast-check to generate random valid vault payloads; after `up`, each INSERT with `status='draft'` must succeed and be retrievable
    - `// Feature: vault-migrations, Property 2: draft status insert succeeds after up`

  - [ ]* 2.5 Write property test — Property 3: vaultStore column list compatibility
    - **Property 3: vaultStore column list compatibility**
    - **Validates: Requirements 1.1, 1.2, 1.3, 6.4**
    - Use fast-check to generate random vault data; after `up`, every INSERT using the exact `vaultStore.ts` column list must succeed
    - `// Feature: vault-migrations, Property 3: vaultStore column list compatibility`

  - [ ]* 2.6 Write property test — Property 4: Rollback draft-row guard
    - **Property 4: Rollback draft-row guard**
    - **Validates: Requirements 5.4, 6.5**
    - Use fast-check to generate databases with N (0–20) draft rows; after `up` + seeding + `down`, verify no silent data loss (rows either migrated to 'active' or error raised)
    - `// Feature: vault-migrations, Property 4: rollback draft-row guard`

  - [ ]* 2.7 Write property test — Property 5: Index consistency after up and down
    - **Property 5: Index consistency after up and down**
    - **Validates: Requirements 2.1, 2.2, 2.3**
    - Use fast-check; after each up/down cycle, query `pg_indexes` and assert the index name set on `vaults` is identical to the pre-migration set
    - `// Feature: vault-migrations, Property 5: index consistency after up and down`

  - [ ]* 2.8 Write property test — Property 6: Log entries contain no PII
    - **Property 6: Log entries contain no PII**
    - **Validates: Requirements 7.4**
    - Use fast-check to generate vault data with Stellar-like addresses (G + 55 base32 chars); spy on `console.log`; run `up` and `down`; assert no log entry matches the Stellar address pattern
    - `// Feature: vault-migrations, Property 6: log entries contain no PII`

- [ ] 3. Checkpoint — ensure all migration tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Update Prisma schema
  - In `prisma/schema.prisma`:
    - Add `DRAFT` to `VaultStatus` enum
    - Rename `startTimestamp` → `startDate` with `@map("start_date")`
    - Rename `endTimestamp` → `endDate` with `@map("end_date")`
    - Add `verifier String` field
    - Add `updatedAt DateTime @updatedAt @map("updated_at")`
    - Change `status` default to `VaultStatus.DRAFT`
    - Add `@@index([endDate])` replacing `@@index([endTimestamp])`
  - _Requirements: 4.1–4.5_

- [x] 5. Update documentation
  - In `docs/database-migrations.md`:
    - Add a section describing `20260227000000_fix_vault_schema.cjs`
    - Document the columns added/renamed and the enum change
    - Note the rollback procedure for `'draft'` status rows
  - _Requirements: 8.1–8.3_

- [x] 6. Final checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Property tests require `fast-check` (`npm install --save-dev fast-check`)
- Tests require `DATABASE_URL` pointing to a writable test PostgreSQL instance; they skip gracefully if not set
- The `ALTER TYPE … ADD VALUE` enum caveat applies to PostgreSQL < 12 — the migration handles this automatically

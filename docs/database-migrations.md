# Database Migrations Strategy

This backend uses **Knex + PostgreSQL** for schema migrations.

## Why this tool

- Works well with Node.js/TypeScript projects.
- Supports `up` and `down` migrations for safe rollouts and rollbacks.
- CLI is easy to run locally and in CI/CD.

## Configuration

- Knex config: `knexfile.cjs`
- Migrations directory: `db/migrations`
- Migration tracking table: `knex_migrations`
- Connection source: `DATABASE_URL`

## Baseline migration

- Baseline file: `db/migrations/20260225190000_initial_baseline.cjs`
- Creates:
  - `vaults` table
  - `vault_status` enum type
  - indexes on `creator`, `status`, `end_timestamp`
- Rollback drops `vaults` and `vault_status`.

## Local developer workflow

1. Set `DATABASE_URL` to a writable Postgres instance.
2. Apply pending migrations:
   ```bash
   npm run migrate:latest
   ```
3. Check current state:
   ```bash
   npm run migrate:status
   ```
4. Create a new migration:
   ```bash
   npm run migrate:make add_some_change
   ```
5. Fill in `exports.up` and `exports.down` in the new file.
6. Re-run `npm run migrate:latest` and test application behavior.
7. If needed, rollback one batch:
   ```bash
   npm run migrate:rollback
   ```

## Migration authoring rules

- One logical schema change per migration.
- Always implement both `up` and `down`.
- Keep migration files immutable after merge.
- Prefer additive, backward-compatible changes for zero-downtime deploys.

## CI/CD integration

Run migrations in deployment pipelines before starting app instances on new code.

This repository includes a CI example at `.github/workflows/ci.yml` that:

- starts PostgreSQL in GitHub Actions
- runs `npm run migrate:latest`
- verifies state with `npm run migrate:status`

Example deployment step:

```bash
npm ci
npm run migrate:latest
npm run build
npm run start
```

Example GitHub Actions job fragment:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run migrate:latest
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
      - run: npm run build
```

## Rollback strategy

- Immediate rollback path for the last batch:
  ```bash
  npm run migrate:rollback
  ```
- Keep database backups/snapshots in production for disaster recovery.
- For destructive changes, use multi-step deploys (additive migration, backfill, cleanup migration).

## Corrective migration: `20260227000000_fix_vault_schema.cjs`

This migration closes the schema drift between the Knex-managed `vaults` / `milestones` tables and the `PersistedVault` / `PersistedMilestone` TypeScript interfaces used by `vaultStore.ts`.

### Changes applied (`exports.up`)

| Change | Detail |
|---|---|
| Column rename | `start_timestamp` → `start_date` |
| Column rename | `end_timestamp` → `end_date` |
| Column added | `verifier VARCHAR(255) NOT NULL` |
| Column added | `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` |
| Index dropped | `idx_vaults_end_timestamp` (references old column name) |
| Index created | `idx_vaults_end_date` on `end_date` |
| Enum value added | `'draft'` added to `vault_status` |
| Status default changed | `status` default changed from `'active'` to `'draft'` |
| Milestones aligned | Adds `sort_order`, `amount`, `due_date` columns if missing |

### Rollback procedure (`exports.down`)

> **Important:** If any vault rows have `status = 'draft'` when rollback runs, those rows are automatically updated to `status = 'active'` before the enum value is removed. This is logged (without row data) and is not silent.

Steps performed by `exports.down`:

1. Any `'draft'` rows are updated to `'active'` (with a warning log).
2. `status` default is restored to `'active'`.
3. `'draft'` is removed from `vault_status` via the create-new-enum / cast / drop-old / rename pattern.
4. `idx_vaults_end_date` is dropped; `idx_vaults_end_timestamp` is recreated.
5. `updated_at` and `verifier` columns are dropped.
6. `end_date` → `end_timestamp` and `start_date` → `start_timestamp` are renamed back.
7. Any milestones columns added in `up` are dropped.

### Prisma schema alignment

`prisma/schema.prisma` was updated in the same change:

- `VaultStatus` enum gains `DRAFT`
- `startTimestamp` / `endTimestamp` renamed to `startDate` / `endDate` with `@map` directives
- `verifier String` field added
- `updatedAt DateTime @updatedAt @map("updated_at")` added
- Status default changed to `DRAFT`
- Index updated to `@@index([endDate])`

### Security / PII note

The migration emits structured JSON log entries for each step (step name + status only). No column values — wallet addresses, amounts, or destinations — are logged at any level.

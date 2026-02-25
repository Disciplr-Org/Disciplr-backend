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

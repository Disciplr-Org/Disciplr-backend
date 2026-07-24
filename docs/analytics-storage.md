# Analytics Storage

Analytics data is persisted in PostgreSQL. The SQLite (`better-sqlite3`) dependency
was removed after the PostgreSQL migration was completed (see issue #334).

## Data model

### `analytics_vault_summary`

Single-row summary keyed by `id=1`:

- `total_vaults`, `active_vaults`, `completed_vaults`, `failed_vaults`
- `total_locked_capital`, `active_capital`, `success_rate`
- `last_updated`

### `analytics_vault_daily_rollups`

Daily materialized rollup keyed by `bucket_date` with the same aggregate fields.
Supports historical analytics and backfill verification.

## Runtime storage mode

Set `ANALYTICS_STORAGE=postgres` to enable PostgreSQL reads for the analytics summary
endpoint. When unset the endpoint returns empty aggregates (safe default for environments
without a live database).

## Backfill

Call `backfillAnalyticsStorage()` from `src/db/database.ts` to initialise the
PostgreSQL tables and recompute all aggregates from the `vaults` table.

## Validation checklist

1. Run migration: `npm run migrate:latest`
2. Set `ANALYTICS_STORAGE=postgres` and trigger a summary recompute.
3. Verify row counts and totals against the `vaults` table.
4. Run contract tests: `npm test -- tests/analytics.test.ts`

## Security / privacy

Analytics responses remain aggregate-only. No PII is emitted by `/api/analytics`.
Audit logs and privacy-logger behaviour are unchanged.

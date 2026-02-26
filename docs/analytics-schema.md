# Analytics Schema – Design & Migration Docs

## Overview

This document describes the minimal schema that powers the vault analytics engine: vault performance, behavioral scoring, and capital efficiency.

---

## Ownership Boundaries

| Layer | Schema | Owned by | Purpose |
|---|---|---|---|
| **OLTP (transactional)** | `public` | Prior migrations (e.g. `initial_baseline`) | Source of truth: `vaults`, `vault_status`, etc. |
| **Analytics** | `analytics` | `20260226100000_analytics_schema.cjs` | Aggregated, query-optimised views of OLTP data |

The analytics schema is **read-only from the application layer**. It is populated by:
- An ETL job / event listener that mirrors OLTP writes into `analytics.*` tables.
- Periodic `REFRESH MATERIALIZED VIEW` calls (see `refreshAnalyticsViews()` in the route file).

This separation means OLTP tables are never blocked by analytical queries and analytical reads are never slowed by transactional writes.

---

## Migration File

```
db/migrations/20260226100000_analytics_schema.cjs
```

### Tables

#### `analytics.vault_lifecycle_summary`
One row per vault. The authoritative analytics record of a vault's lifecycle from creation to completion or cancellation.

| Column | Type | Notes |
|---|---|---|
| `vault_id` | `uuid` PK | Soft FK to `public.vaults.id` |
| `status` | `varchar(32)` | Snapshot of current vault status |
| `creator_address` | `varchar(255)` | Vault creator wallet address |
| `created_at` | `timestamptz` | OLTP creation time |
| `activated_at` | `timestamptz` | When vault moved to active |
| `completed_at` | `timestamptz` | When vault completed |
| `cancelled_at` | `timestamptz` | When vault was cancelled |
| `total_deposited` | `numeric(36,18)` | Lifetime capital in |
| `total_withdrawn` | `numeric(36,18)` | Lifetime capital out |
| `total_yield_generated` | `numeric(36,18)` | Yield accumulated |
| `current_tvl` | `numeric(36,18)` | Current total value locked |
| `milestone_count` | `int` | Total milestones defined |
| `milestones_completed` | `int` | Milestones hit |
| `completion_rate` | `numeric(5,4)` | 0–1 ratio |
| `capital_efficiency_score` | `numeric(5,4)` | 0–1 ratio |
| `active_duration_seconds` | `int` | activated_at → completed_at |
| `analytics_updated_at` | `timestamptz` | Last ETL refresh |

---

#### `analytics.milestone_performance`
One row per milestone per vault. Captures individual milestone outcomes for granular performance analysis.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `vault_id` | `uuid` FK | → `vault_lifecycle_summary` |
| `milestone_index` | `int` | 0-based position in vault |
| `status` | `varchar(32)` | pending / completed / missed |
| `target_amount` | `numeric(36,18)` | Goal amount |
| `actual_amount` | `numeric(36,18)` | Amount reached |
| `achievement_ratio` | `numeric(5,4)` | actual / target |
| `due_at` | `timestamptz` | Scheduled deadline |
| `completed_at` | `timestamptz` | Actual completion |
| `completion_lag_seconds` | `int` | Negative = early, positive = late |

---

#### `analytics.capital_flow`
Immutable event log of all capital movements. Never updated – append-only.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `vault_id` | `uuid` | Soft FK |
| `user_address` | `varchar(255)` | Wallet address |
| `flow_type` | `varchar(32)` | deposit / withdrawal / yield / fee / penalty |
| `amount` | `numeric(36,18)` | |
| `token_symbol` | `varchar(20)` | |
| `tx_hash` | `varchar(255)` | Unique; maps to on-chain tx |
| `occurred_at` | `timestamptz` | Event time |
| `period_date` | `date` | Pre-computed daily bucket |
| `period_week` | `int` | ISO week number |
| `period_month` | `int` | YYYYMM |
| `period_year` | `int` | |

---

#### `analytics.user_aggregates`
One row per user. Updated by the ETL/scoring engine on each activity event.

| Column | Type | Notes |
|---|---|---|
| `user_address` | `varchar(255)` PK | |
| `vaults_created` | `int` | |
| `vaults_participated` | `int` | |
| `vaults_completed` | `int` | |
| `vaults_abandoned` | `int` | |
| `total_deposited_lifetime` | `numeric(36,18)` | |
| `total_withdrawn_lifetime` | `numeric(36,18)` | |
| `total_yield_earned_lifetime` | `numeric(36,18)` | |
| `current_active_tvl` | `numeric(36,18)` | |
| `commitment_score` | `int` | 0–100; follow-through on goals |
| `consistency_score` | `int` | 0–100; regularity of contributions |
| `capital_efficiency_score` | `int` | 0–100; productive capital use |
| `overall_behavioral_score` | `int` | 0–100; weighted composite |
| `first_activity_at` | `timestamptz` | |
| `last_activity_at` | `timestamptz` | |

---

### Materialized Views

#### `analytics.mv_vault_performance`
Refreshable snapshot joining `vault_lifecycle_summary` with a 30-day lateral capital flow aggregate. Used by `GET /analytics/vaults`.

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_vault_performance;
```

#### `analytics.mv_user_behavioral_scores`
Refreshable snapshot of `user_aggregates` with a derived `creator_completion_rate` column. Used by `GET /analytics/users`.

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_user_behavioral_scores;
```

> **Both views are created `WITH NO DATA`** and must be refreshed before first use. Add an initial refresh step to deployment scripts or trigger it via `refreshAnalyticsViews()`.

---

## Route → Schema Mapping

| Route | Primary table/view |
|---|---|
| `GET /analytics/overview` | `analytics.vault_lifecycle_summary` |
| `GET /analytics/vaults` | `analytics.mv_vault_performance` |
| `GET /analytics/vaults/:id` | `vault_lifecycle_summary` + `milestone_performance` + `capital_flow` |
| `GET /analytics/capital-flow` | `analytics.capital_flow` |
| `GET /analytics/users` | `analytics.mv_user_behavioral_scores` |
| `GET /analytics/users/:addr` | `analytics.user_aggregates` + `capital_flow` |

---

## Running the Migration

```bash
# Apply
npm run migrate:latest

# Verify
npm run migrate:status

# Rollback (drops entire analytics schema)
npm run migrate:rollback
```

After first deploy, seed the materialized views:
```sql
REFRESH MATERIALIZED VIEW analytics.mv_vault_performance;
REFRESH MATERIALIZED VIEW analytics.mv_user_behavioral_scores;
```
/**
 * Migration: analytics_schema
 *
 * Creates the analytics schema to support the vault performance engine,
 * behavioral scoring, and capital efficiency reporting.
 *
 * Ownership boundaries:
 *   OLTP (transactional) schema  → public.*  (vaults, etc. – owned by prior migrations)
 *   Analytics schema             → analytics.* (owned by this migration)
 *
 * Tables created:
 *   analytics.vault_lifecycle_summary   – one row per vault, rolled-up lifecycle state
 *   analytics.milestone_performance     – per-milestone outcomes within a vault
 *   analytics.capital_flow              – capital in/out events (deposits, withdrawals, yields)
 *   analytics.user_aggregates           – per-user behavioural & capital-efficiency scores
 *
 * Materialized views created:
 *   analytics.mv_vault_performance      – refreshable snapshot joining the above tables
 *   analytics.mv_user_behavioral_scores – refreshable snapshot of user scoring
 */

'use strict';

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  // ── 0. Create analytics schema ───────────────────────────────────────────
  await knex.raw('CREATE SCHEMA IF NOT EXISTS analytics');

  // ── 1. vault_lifecycle_summary ───────────────────────────────────────────
  // One row per vault. Updated by ETL / triggers from OLTP vaults table.
  await knex.schema.withSchema('analytics').createTable('vault_lifecycle_summary', (t) => {
    t.uuid('vault_id').primary().notNullable()
      .comment('FK to public.vaults.id – not enforced across schemas for perf');
    t.string('status', 32).notNullable().defaultTo('pending')
      .comment('Snapshot of vault status at last refresh');
    t.string('creator_address', 255).notNullable();

    // Lifecycle timestamps (nullable – not all phases apply to every vault)
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.timestamp('activated_at', { useTz: true }).nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.timestamp('cancelled_at', { useTz: true }).nullable();

    // Capital summary (stored as numeric strings to preserve precision)
    t.decimal('total_deposited', 36, 18).notNullable().defaultTo(0);
    t.decimal('total_withdrawn', 36, 18).notNullable().defaultTo(0);
    t.decimal('total_yield_generated', 36, 18).notNullable().defaultTo(0);
    t.decimal('current_tvl', 36, 18).notNullable().defaultTo(0);

    // Performance
    t.integer('milestone_count').notNullable().defaultTo(0);
    t.integer('milestones_completed').notNullable().defaultTo(0);
    t.decimal('completion_rate', 5, 4).nullable()
      .comment('milestones_completed / milestone_count, 0–1');
    t.decimal('capital_efficiency_score', 5, 4).nullable()
      .comment('Ratio of productive capital deployment, 0–1');

    // Duration metrics (seconds)
    t.integer('active_duration_seconds').nullable();

    t.timestamp('analytics_updated_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_vls_status
      ON analytics.vault_lifecycle_summary (status);
    CREATE INDEX idx_vls_creator
      ON analytics.vault_lifecycle_summary (creator_address);
    CREATE INDEX idx_vls_created_at
      ON analytics.vault_lifecycle_summary (created_at DESC);
  `);

  // ── 2. milestone_performance ──────────────────────────────────────────────
  // One row per milestone within a vault.
  await knex.schema.withSchema('analytics').createTable('milestone_performance', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('vault_id').notNullable()
      .references('vault_id').inTable('analytics.vault_lifecycle_summary')
      .onDelete('CASCADE');
    t.integer('milestone_index').notNullable()
      .comment('0-based order of milestone within vault');
    t.string('milestone_label', 255).nullable();

    t.string('status', 32).notNullable().defaultTo('pending');
    t.decimal('target_amount', 36, 18).nullable();
    t.decimal('actual_amount', 36, 18).nullable();
    t.decimal('achievement_ratio', 5, 4).nullable()
      .comment('actual_amount / target_amount');

    t.timestamp('due_at', { useTz: true }).nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.integer('completion_lag_seconds').nullable()
      .comment('completed_at - due_at; negative = early, positive = late');

    t.timestamp('analytics_updated_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    t.unique(['vault_id', 'milestone_index']);
  });

  await knex.raw(`
    CREATE INDEX idx_mp_vault_id
      ON analytics.milestone_performance (vault_id);
    CREATE INDEX idx_mp_status
      ON analytics.milestone_performance (status);
  `);

  // ── 3. capital_flow ───────────────────────────────────────────────────────
  // Immutable event log of all capital movements, sourced from OLTP events.
  await knex.schema.withSchema('analytics').createTable('capital_flow', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('vault_id').notNullable();
    t.string('user_address', 255).notNullable();

    t.string('flow_type', 32).notNullable()
      .comment("'deposit' | 'withdrawal' | 'yield' | 'fee' | 'penalty'");
    t.decimal('amount', 36, 18).notNullable();
    t.string('token_symbol', 20).nullable();
    t.string('tx_hash', 255).nullable().unique();

    // Time dimensions for efficient period roll-ups
    t.timestamp('occurred_at', { useTz: true }).notNullable();
    t.date('period_date').notNullable()
      .comment('Derived from occurred_at for daily aggregation');
    t.integer('period_week').nullable()
      .comment('ISO week number');
    t.integer('period_month').nullable()
      .comment('YYYYMM integer for monthly roll-ups');
    t.integer('period_year').nullable();

    t.timestamp('analytics_inserted_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_cf_vault_id
      ON analytics.capital_flow (vault_id);
    CREATE INDEX idx_cf_user_address
      ON analytics.capital_flow (user_address);
    CREATE INDEX idx_cf_flow_type
      ON analytics.capital_flow (flow_type);
    CREATE INDEX idx_cf_occurred_at
      ON analytics.capital_flow (occurred_at DESC);
    CREATE INDEX idx_cf_period_date
      ON analytics.capital_flow (period_date DESC);
  `);

  // ── 4. user_aggregates ────────────────────────────────────────────────────
  // One row per user, updated periodically by the analytics engine.
  await knex.schema.withSchema('analytics').createTable('user_aggregates', (t) => {
    t.string('user_address', 255).primary();

    // Activity counts
    t.integer('vaults_created').notNullable().defaultTo(0);
    t.integer('vaults_participated').notNullable().defaultTo(0);
    t.integer('vaults_completed').notNullable().defaultTo(0);
    t.integer('vaults_abandoned').notNullable().defaultTo(0);

    // Capital metrics
    t.decimal('total_deposited_lifetime', 36, 18).notNullable().defaultTo(0);
    t.decimal('total_withdrawn_lifetime', 36, 18).notNullable().defaultTo(0);
    t.decimal('total_yield_earned_lifetime', 36, 18).notNullable().defaultTo(0);
    t.decimal('current_active_tvl', 36, 18).notNullable().defaultTo(0);

    // Behavioral scores (0–100 integer scale, nullable until enough data)
    t.integer('commitment_score').nullable()
      .comment('Measures follow-through on vault goals');
    t.integer('consistency_score').nullable()
      .comment('Measures regularity of capital contributions');
    t.integer('capital_efficiency_score').nullable()
      .comment('Measures productive use of deposited capital');
    t.integer('overall_behavioral_score').nullable()
      .comment('Weighted composite of sub-scores');

    // Temporal
    t.timestamp('first_activity_at', { useTz: true }).nullable();
    t.timestamp('last_activity_at', { useTz: true }).nullable();
    t.timestamp('analytics_updated_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_ua_overall_score
      ON analytics.user_aggregates (overall_behavioral_score DESC NULLS LAST);
    CREATE INDEX idx_ua_last_activity
      ON analytics.user_aggregates (last_activity_at DESC NULLS LAST);
  `);

  // ── 5. Materialized view: mv_vault_performance ────────────────────────────
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_vault_performance AS
    SELECT
      vls.vault_id,
      vls.status,
      vls.creator_address,
      vls.created_at,
      vls.activated_at,
      vls.completed_at,
      vls.total_deposited,
      vls.total_withdrawn,
      vls.total_yield_generated,
      vls.current_tvl,
      vls.milestone_count,
      vls.milestones_completed,
      vls.completion_rate,
      vls.capital_efficiency_score,
      vls.active_duration_seconds,
      -- Capital flow aggregates (last 30 days)
      COALESCE(recent.net_flow_30d, 0)          AS net_flow_30d,
      COALESCE(recent.deposit_count_30d, 0)     AS deposit_count_30d,
      COALESCE(recent.unique_depositors_30d, 0) AS unique_depositors_30d
    FROM analytics.vault_lifecycle_summary vls
    LEFT JOIN LATERAL (
      SELECT
        SUM(CASE WHEN flow_type = 'deposit'    THEN amount ELSE 0 END)
        - SUM(CASE WHEN flow_type = 'withdrawal' THEN amount ELSE 0 END) AS net_flow_30d,
        COUNT(*) FILTER (WHERE flow_type = 'deposit')                    AS deposit_count_30d,
        COUNT(DISTINCT user_address) FILTER (WHERE flow_type = 'deposit') AS unique_depositors_30d
      FROM analytics.capital_flow cf
      WHERE cf.vault_id = vls.vault_id
        AND cf.occurred_at >= NOW() - INTERVAL '30 days'
    ) recent ON TRUE
    WITH NO DATA;

    CREATE UNIQUE INDEX idx_mvvp_vault_id
      ON analytics.mv_vault_performance (vault_id);
    CREATE INDEX idx_mvvp_status
      ON analytics.mv_vault_performance (status);
    CREATE INDEX idx_mvvp_creator
      ON analytics.mv_vault_performance (creator_address);
  `);

  // ── 6. Materialized view: mv_user_behavioral_scores ──────────────────────
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_user_behavioral_scores AS
    SELECT
      ua.user_address,
      ua.vaults_created,
      ua.vaults_completed,
      ua.vaults_abandoned,
      ua.total_deposited_lifetime,
      ua.total_yield_earned_lifetime,
      ua.current_active_tvl,
      ua.commitment_score,
      ua.consistency_score,
      ua.capital_efficiency_score,
      ua.overall_behavioral_score,
      ua.first_activity_at,
      ua.last_activity_at,
      -- Derived completion rate
      CASE
        WHEN ua.vaults_created > 0
        THEN ROUND(ua.vaults_completed::numeric / ua.vaults_created, 4)
        ELSE NULL
      END AS creator_completion_rate
    FROM analytics.user_aggregates ua
    WITH NO DATA;

    CREATE UNIQUE INDEX idx_mvubs_user_address
      ON analytics.mv_user_behavioral_scores (user_address);
    CREATE INDEX idx_mvubs_overall_score
      ON analytics.mv_user_behavioral_scores (overall_behavioral_score DESC NULLS LAST);
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_user_behavioral_scores CASCADE');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_vault_performance CASCADE');
  await knex.schema.withSchema('analytics').dropTableIfExists('user_aggregates');
  await knex.schema.withSchema('analytics').dropTableIfExists('capital_flow');
  await knex.schema.withSchema('analytics').dropTableIfExists('milestone_performance');
  await knex.schema.withSchema('analytics').dropTableIfExists('vault_lifecycle_summary');
  await knex.raw('DROP SCHEMA IF EXISTS analytics CASCADE');
};

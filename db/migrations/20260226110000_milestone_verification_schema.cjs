'use strict';

/**
 * Migration: milestone_verification_schema
 *
 * Creates the tables required to support manual human verification of milestones.
 *
 * New tables:
 *   milestone_verifiers        – maps a verifier (user) to a specific milestone (assignment)
 *   milestone_verification_events – immutable audit log of every verifier action
 *   milestone_info_requests    – tracks "request more info" threads
 *
 * Status flow for a milestone (extends the existing vaults/milestones OLTP model):
 *   pending_verification
 *     ├─► approved     (approveMilestone)
 *     ├─► rejected     (rejectMilestone)
 *     └─► info_requested → pending_verification  (requestMoreInfo → submitter responds)
 *
 * Ownership: public schema (OLTP), same as vaults.
 */

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  // ── 0. Verification status enum ──────────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE milestone_verification_status AS ENUM (
        'pending_verification',
        'info_requested',
        'approved',
        'rejected'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // ── 1. milestone_verifiers ────────────────────────────────────────────────
  // Associates one or more human verifiers with a milestone.
  // A verifier must appear here to be permitted to act on a milestone.
  await knex.schema.createTable('milestone_verifiers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Soft FK to public.vaults(id) – vault context for quick access checks
    t.uuid('vault_id').notNullable().index();

    // Milestone identifier – integer index within the vault (matches analytics schema)
    t.integer('milestone_index').notNullable();

    // The assigned verifier
    t.string('verifier_address', 255).notNullable();
    t.string('verifier_email', 255).nullable()
      .comment('Stored at assignment time for notification hooks');

    // Assignment metadata
    t.string('assigned_by', 255).notNullable()
      .comment('Address of the admin/creator who made the assignment');
    t.timestamp('assigned_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('revoked_at', { useTz: true }).nullable()
      .comment('Soft-delete: set when verifier is unassigned');

    t.unique(['vault_id', 'milestone_index', 'verifier_address']);
  });

  await knex.raw(`
    CREATE INDEX idx_mv_verifier_address
      ON milestone_verifiers (verifier_address);
    CREATE INDEX idx_mv_vault_milestone
      ON milestone_verifiers (vault_id, milestone_index);
  `);

  // ── 2. milestone_verification_events ─────────────────────────────────────
  // Immutable audit log. One row per action taken by a verifier.
  await knex.schema.createTable('milestone_verification_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.uuid('vault_id').notNullable().index();
    t.integer('milestone_index').notNullable();

    t.string('verifier_address', 255).notNullable();
    t.specificType('action', 'milestone_verification_status').notNullable();

    t.text('notes').nullable()
      .comment('Verifier-supplied reasoning for approval, rejection, or info request');

    // For info_requested actions, links to the info request record
    t.uuid('info_request_id').nullable();

    // Snapshot of milestone status before this action (for audit / rollback analysis)
    t.string('previous_status', 64).nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_mve_vault_milestone
      ON milestone_verification_events (vault_id, milestone_index);
    CREATE INDEX idx_mve_verifier
      ON milestone_verification_events (verifier_address);
    CREATE INDEX idx_mve_action
      ON milestone_verification_events (action);
    CREATE INDEX idx_mve_created_at
      ON milestone_verification_events (created_at DESC);
  `);

  // ── 3. milestone_info_requests ────────────────────────────────────────────
  // Each "request more info" creates one record. The submitter responds by
  // updating responded_at and response_notes, which triggers status revert
  // to pending_verification.
  await knex.schema.createTable('milestone_info_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.uuid('vault_id').notNullable().index();
    t.integer('milestone_index').notNullable();

    // The verifier who raised the request
    t.string('requested_by', 255).notNullable();
    t.text('question').notNullable()
      .comment('What additional information the verifier needs');

    // The vault creator/submitter who must respond
    t.string('responding_party', 255).notNullable()
      .comment('Address expected to provide the response');

    // Response
    t.text('response_notes').nullable();
    t.timestamp('responded_at', { useTz: true }).nullable();

    // Lifecycle
    t.boolean('is_resolved').notNullable().defaultTo(false);
    t.timestamp('resolved_at', { useTz: true }).nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_mir_vault_milestone
      ON milestone_info_requests (vault_id, milestone_index);
    CREATE INDEX idx_mir_responding_party
      ON milestone_info_requests (responding_party);
    CREATE INDEX idx_mir_is_resolved
      ON milestone_info_requests (is_resolved);
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('milestone_info_requests');
  await knex.schema.dropTableIfExists('milestone_verification_events');
  await knex.schema.dropTableIfExists('milestone_verifiers');
  await knex.raw('DROP TYPE IF EXISTS milestone_verification_status CASCADE');
};

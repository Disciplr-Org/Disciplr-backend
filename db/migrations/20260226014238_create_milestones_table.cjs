/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // This migration is disabled to avoid conflicts with 20260225200000_create_milestones.cjs
  // The first migration should handle the milestones table creation
  // This file exists to prevent migration gaps but does nothing
  console.log(
    "Migration 20260226014238_create_milestones_table.cjs is disabled - using 20260225200000_create_milestones.cjs instead",
  );
  return Promise.resolve();
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  // This migration is disabled - no-op
  console.log(
    "Migration 20260226014238_create_milestones_table.cjs down is disabled - no-op",
  );
  return Promise.resolve();
};

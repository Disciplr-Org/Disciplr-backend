import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  lintMigrations,
} from '../migration-lint.mjs'

describe('migration-lint', () => {
  it('passes on the project historical migrations directory', () => {
    const projectMigrationsDir = path.resolve(process.cwd(), 'db/migrations')
    const result = lintMigrations(projectMigrationsDir)
    assert.equal(result.valid, true, `Expected valid, got errors: ${result.errors.join(', ')}`)
    assert.deepEqual(result.errors, [])
  })

  it('fails when a newly added migration is empty', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-empty-'))
    try {
      // Create a valid migration
      fs.writeFileSync(
        path.join(tempDir, '20261101000000_valid_migration.cjs'),
        `exports.up = async function(knex) { await knex.schema.createTable('t', () => {}); };\nexports.down = async function(knex) { await knex.schema.dropTable('t'); };\n`,
      )
      // Create an empty new migration (not in allowlist)
      fs.writeFileSync(
        path.join(tempDir, '20261102000000_empty_migration.cjs'),
        `exports.up = async function(knex) {\n  // empty\n};\nexports.down = async function(knex) {\n};\n`,
      )

      const result = lintMigrations(tempDir)
      assert.equal(result.valid, false)
      assert.equal(result.errors.length, 1)
      assert.match(result.errors[0], /Empty migration not allowed/)
      assert.match(result.errors[0], /20261102000000_empty_migration\.cjs/)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('fails when new migrations share a duplicate timestamp', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-dup-'))
    try {
      fs.writeFileSync(
        path.join(tempDir, '20261201000000_first_migration.cjs'),
        `exports.up = async function(knex) { await knex.raw('SELECT 1'); };\nexports.down = async function(knex) { await knex.raw('SELECT 1'); };\n`,
      )
      fs.writeFileSync(
        path.join(tempDir, '20261201000000_second_migration.cjs'),
        `exports.up = async function(knex) { await knex.raw('SELECT 2'); };\nexports.down = async function(knex) { await knex.raw('SELECT 2'); };\n`,
      )

      const result = lintMigrations(tempDir)
      assert.equal(result.valid, false)
      assert.equal(result.errors.length, 1)
      assert.match(result.errors[0], /Duplicate migration timestamp 20261201000000 found/)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('passes when an empty migration is in the allowlist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-allow-empty-'))
    try {
      fs.writeFileSync(
        path.join(tempDir, '20260602115607_add_soft_delete_to_vaults_and_milestones.cjs'),
        `exports.up = function(knex) {};\nexports.down = function(knex) {};\n`,
      )

      const result = lintMigrations(tempDir)
      assert.equal(result.valid, true)
      assert.deepEqual(result.errors, [])
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('passes when duplicate timestamps are in the allowlist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-allow-dup-'))
    try {
      fs.writeFileSync(
        path.join(tempDir, '20260602000000_create_milestone_embeddings.cjs'),
        `exports.up = async function(knex) { await knex.raw('SELECT 1'); };\nexports.down = async function(knex) { await knex.raw('SELECT 1'); };\n`,
      )
      fs.writeFileSync(
        path.join(tempDir, '20260602000000_create_org_quotas.cjs'),
        `exports.up = async function(knex) { await knex.raw('SELECT 2'); };\nexports.down = async function(knex) { await knex.raw('SELECT 2'); };\n`,
      )

      const result = lintMigrations(tempDir)
      assert.equal(result.valid, true)
      assert.deepEqual(result.errors, [])
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

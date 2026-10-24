import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateSchema } from '../check-schema.mjs'

describe('check-schema', () => {
  const validMockSchema = {
    columns: {
      vaults: ['id', 'name', 'verifier', 'start_date', 'end_date', 'deleted_at', 'creator', 'status'],
      milestones: ['id', 'vault_id', 'sort_order', 'amount', 'due_date', 'deadline', 'target_amount', 'deleted_at'],
    },
    enums: {
      vault_status: ['active', 'completed', 'failed', 'cancelled', 'draft'],
      milestone_status: ['pending', 'in_progress', 'completed', 'failed', 'approved'],
    },
  }

  it('passes when all required columns and enum values are present', () => {
    const result = validateSchema(validMockSchema)
    assert.equal(result.valid, true)
    assert.deepEqual(result.errors, [])
  })

  it('fails when a required column on vaults is missing', () => {
    const invalidSchema = {
      ...validMockSchema,
      columns: {
        ...validMockSchema.columns,
        vaults: validMockSchema.columns.vaults.filter((c) => c !== 'deleted_at'),
      },
    }
    const result = validateSchema(invalidSchema)
    assert.equal(result.valid, false)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /Missing required column "deleted_at" in table "vaults"/)
  })

  it('fails when a required column on milestones is missing', () => {
    const invalidSchema = {
      ...validMockSchema,
      columns: {
        ...validMockSchema.columns,
        milestones: validMockSchema.columns.milestones.filter((c) => c !== 'sort_order'),
      },
    }
    const result = validateSchema(invalidSchema)
    assert.equal(result.valid, false)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /Missing required column "sort_order" in table "milestones"/)
  })

  it('fails when a required enum value on vault_status is missing', () => {
    const invalidSchema = {
      ...validMockSchema,
      enums: {
        ...validMockSchema.enums,
        vault_status: ['active', 'failed'], // missing 'completed'
      },
    }
    const result = validateSchema(invalidSchema)
    assert.equal(result.valid, false)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /Missing required enum value "completed" in enum "vault_status"/)
  })

  it('fails when a required enum value on milestone_status is missing', () => {
    const invalidSchema = {
      ...validMockSchema,
      enums: {
        ...validMockSchema.enums,
        milestone_status: ['completed', 'failed'], // missing 'pending'
      },
    }
    const result = validateSchema(invalidSchema)
    assert.equal(result.valid, false)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /Missing required enum value "pending" in enum "milestone_status"/)
  })

  it('fails when an entire required table is missing', () => {
    const invalidSchema = {
      ...validMockSchema,
      columns: {
        vaults: validMockSchema.columns.vaults,
      },
    }
    const result = validateSchema(invalidSchema)
    assert.equal(result.valid, false)
    assert.match(result.errors[0], /Missing table: "milestones"/)
  })

  it('fails when an entire required enum is missing', () => {
    const invalidSchema = {
      ...validMockSchema,
      enums: {
        milestone_status: validMockSchema.enums.milestone_status,
      },
    }
    const result = validateSchema(invalidSchema)
    assert.equal(result.valid, false)
    assert.match(result.errors[0], /Missing enum type: "vault_status"/)
  })
})

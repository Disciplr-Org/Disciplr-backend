import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createVaultSchema, flattenZodErrors, isMemoRequired } from '../services/vaultValidation.js'

// Generated valid addresses for test cases
const VALID_CLASSIC_2 = 'GBXKACE7RFAYLW7JDGRIRC2ZORDHL7YCRT5OUR3MKKXGO5AS4DQEMOXL'
const VALID_CONTRACT = 'CAJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBERTS'
const VALID_MUXED_1 = 'MDHWBXJFCTBJ6ZQPK2E64JAOMHQOEOMWQ43Q5C3J6TEA6SNOFELWAAAAAAAAAAAAPMWVQ'
const ZERO_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const ALL_ONES_ADDRESS = 'GD7777777777777777777777777777777777777777777777777773DB'

// Helper to construct a valid base payload
const buildValidPayload = () => ({
  amount: '1000',
  startDate: '2026-06-28T12:00:00Z',
  endDate: '2026-06-29T12:00:00Z',
  verifier: VALID_CLASSIC_2,
  destinations: {
    success: VALID_CLASSIC_2,
    failure: VALID_CLASSIC_2,
  },
  milestones: [
    {
      title: 'Milestone 1',
      dueDate: '2026-06-28T18:00:00Z',
      amount: '1000',
    },
  ],
})

test('accepts valid classic and muxed addresses', () => {
  const payload = buildValidPayload()
  payload.verifier = VALID_CLASSIC_2
  payload.destinations.success = VALID_MUXED_1
  payload.destinations.failure = VALID_CLASSIC_2

  const result = createVaultSchema.safeParse(payload)
  assert.ok(result.success, `Expected payload to validate successfully but failed: ${JSON.stringify(result.error)}`)
})

test('rejects contract addresses for verifier and destinations', () => {
  // 1. Verifier as contract
  const p1 = buildValidPayload()
  p1.verifier = VALID_CONTRACT
  const r1 = createVaultSchema.safeParse(p1)
  assert.equal(r1.success, false)
  const err1 = flattenZodErrors(r1.error!)
  assert.ok(err1.some(f => f.path === 'verifier' && f.message.includes('Contract addresses are not allowed')))

  // 2. Success destination as contract
  const p2 = buildValidPayload()
  p2.destinations.success = VALID_CONTRACT
  const r2 = createVaultSchema.safeParse(p2)
  assert.equal(r2.success, false)
  const err2 = flattenZodErrors(r2.error!)
  assert.ok(err2.some(f => f.path === 'destinations.success' && f.message.includes('Contract addresses are not allowed')))
})

test('rejects unsafe zero/burn and all-ones addresses for success/failure destinations', () => {
  // 1. Success destination is zero address
  const p1 = buildValidPayload()
  p1.destinations.success = ZERO_ADDRESS
  const r1 = createVaultSchema.safeParse(p1)
  assert.equal(r1.success, false)
  const err1 = flattenZodErrors(r1.error!)
  assert.ok(err1.some(f => f.path === 'destinations.success' && f.message.includes('cannot be a zero, burn, or unsafe address')))

  // 2. Failure destination is all-ones address
  const p2 = buildValidPayload()
  p2.destinations.failure = ALL_ONES_ADDRESS
  const r2 = createVaultSchema.safeParse(p2)
  assert.equal(r2.success, false)
  const err2 = flattenZodErrors(r2.error!)
  assert.ok(err2.some(f => f.path === 'destinations.failure' && f.message.includes('cannot be a zero, burn, or unsafe address')))
})

test('isMemoRequired returns false for non-exchange address (no Horizon hit in unit test)', async () => {
  // Without a real Horizon connection this will catch and return false — the
  // important thing is it doesn't throw and the muxed fast-path short-circuits.
  const result = await isMemoRequired(VALID_MUXED_1)
  assert.equal(result, false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { validateCreateVault, parseDateAsUtc } from '../validation.mjs'

function generateValidAddresses() {
  return {
    creator: Keypair.random().publicKey(),
    verifier: Keypair.random().publicKey(),
    other1: Keypair.random().publicKey(),
    other2: Keypair.random().publicKey(),
  }
}

function corruptChecksum(address) {
  // Flip one character in the middle
  const pos = 20
  const flipped = address[pos] === 'A' ? 'B' : 'A'
  return address.slice(0, pos) + flipped + address.slice(pos + 1)
}

function baseValidPayload(addresses, now = new Date()) {
  const start = new Date(now.getTime() + 60 * 1000)
  const end = new Date(now.getTime() + 30 * 86400 * 1000)
  return {
    name: 'Test Commitment Vault',
    creator: addresses.creator,
    verifier: addresses.verifier,
    amount: 1000,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    successDestination: addresses.creator,
    failureDestination: addresses.other1,
    milestones: [
      {
        title: 'Milestone 1',
        amount: 400,
        dueDate: new Date(now.getTime() + 10 * 86400 * 1000).toISOString(),
      },
      {
        title: 'Milestone 2',
        amount: 600,
        dueDate: new Date(now.getTime() + 20 * 86400 * 1000).toISOString(),
      },
    ],
  }
}

test('Validation: valid payload passes validation', () => {
  const addrs = generateValidAddresses()
  const now = new Date()
  const payload = baseValidPayload(addrs, now)

  const result = validateCreateVault(payload, { now })
  assert.equal(result.success, true, `Validation should pass: ${JSON.stringify(result.details)}`)
  assert.equal(result.data.creator, addrs.creator)
  assert.equal(result.data.verifier, addrs.verifier)
  assert.equal(result.data.milestones.length, 2)
})

test('Validation: accepts demo payload from README / public HTML', () => {
  const addrs = generateValidAddresses()
  const now = new Date('2026-06-01T00:00:00.000Z')
  const payload = {
    creator: addrs.creator,
    verifier: addrs.verifier,
    amount: 500,
    endDate: '2027-01-01',
    milestones: [
      { title: 'Ship v1', amount: 250 },
      { title: 'Launch', amount: 250 },
    ],
  }

  const result = validateCreateVault(payload, { now })
  assert.equal(result.success, true, `Demo payload must pass: ${JSON.stringify(result.details)}`)
  assert.equal(result.data.milestones[0].dueDate, '2027-01-01T00:00:00.000Z')
  assert.equal(result.data.milestones[1].dueDate, '2027-01-01T00:00:00.000Z')
})

test('Validation: Stellar address checksum validation for creator, verifier, successDestination, failureDestination', () => {
  const addrs = generateValidAddresses()
  const now = new Date()

  // Corrupted creator
  const badCreator = baseValidPayload(addrs, now)
  badCreator.creator = corruptChecksum(addrs.creator)
  const res1 = validateCreateVault(badCreator, { now })
  assert.equal(res1.success, false)
  assert.ok(res1.details.some((d) => d.field === 'creator' && d.code === 'invalid_address'))

  // Corrupted verifier
  const badVerifier = baseValidPayload(addrs, now)
  badVerifier.verifier = corruptChecksum(addrs.verifier)
  const res2 = validateCreateVault(badVerifier, { now })
  assert.equal(res2.success, false)
  assert.ok(res2.details.some((d) => d.field === 'verifier' && d.code === 'invalid_address'))

  // Corrupted successDestination
  const badSuccess = baseValidPayload(addrs, now)
  badSuccess.successDestination = corruptChecksum(addrs.other1)
  const res3 = validateCreateVault(badSuccess, { now })
  assert.equal(res3.success, false)
  assert.ok(res3.details.some((d) => d.field === 'successDestination' && d.code === 'invalid_address'))

  // Corrupted failureDestination
  const badFailure = baseValidPayload(addrs, now)
  badFailure.failureDestination = corruptChecksum(addrs.other2)
  const res4 = validateCreateVault(badFailure, { now })
  assert.equal(res4.success, false)
  assert.ok(res4.details.some((d) => d.field === 'failureDestination' && d.code === 'invalid_address'))

  // Reject muxed (M...) addresses explicitly
  const muxedPayload = baseValidPayload(addrs, now)
  muxedPayload.creator = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK'
  const resMuxed = validateCreateVault(muxedPayload, { now })
  assert.equal(resMuxed.success, false)
  assert.ok(resMuxed.details.some((d) => d.field === 'creator' && d.message.includes('muxed M-addresses are not supported')))
})

test('Validation: role constraints (verifier !== creator, failureDestination !== creator)', () => {
  const addrs = generateValidAddresses()
  const now = new Date()

  // creator === verifier
  const sameVerifier = baseValidPayload(addrs, now)
  sameVerifier.verifier = sameVerifier.creator
  const res1 = validateCreateVault(sameVerifier, { now })
  assert.equal(res1.success, false)
  assert.ok(res1.details.some((d) => d.field === 'verifier' && (d.code === 'invalid_role' || d.message.includes('creator'))))

  // failureDestination === creator
  const sameFailure = baseValidPayload(addrs, now)
  sameFailure.failureDestination = sameFailure.creator
  const res2 = validateCreateVault(sameFailure, { now })
  assert.equal(res2.success, false)
  assert.ok(res2.details.some((d) => d.field === 'failureDestination' && (d.code === 'invalid_failure_destination' || d.message.includes('creator'))))
})

test('Validation: date window rules (startDate skew, endDate > startDate, endDate <= 5 years)', () => {
  const addrs = generateValidAddresses()
  const now = new Date('2026-06-01T12:00:00.000Z')

  // startDate a day in the past
  const pastStart = baseValidPayload(addrs, now)
  pastStart.startDate = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
  const res1 = validateCreateVault(pastStart, { now })
  assert.equal(res1.success, false)
  assert.ok(res1.details.some((d) => d.field === 'startDate' && (d.code === 'start_date_in_past' || d.message.includes('past'))))

  // startDate 4 minutes in past is accepted (within 5 min skew)
  const skewStart = baseValidPayload(addrs, now)
  skewStart.startDate = new Date(now.getTime() - 4 * 60 * 1000).toISOString()
  const resSkew = validateCreateVault(skewStart, { now })
  assert.equal(resSkew.success, true)

  // endDate <= startDate
  const badEnd = baseValidPayload(addrs, now)
  badEnd.startDate = new Date(now.getTime() + 2 * 3600 * 1000).toISOString()
  badEnd.endDate = new Date(now.getTime() + 1 * 3600 * 1000).toISOString()
  const res2 = validateCreateVault(badEnd, { now })
  assert.equal(res2.success, false)
  assert.ok(res2.details.some((d) => d.field === 'endDate' && (d.code === 'invalid_end_date' || d.message.includes('after startDate'))))

  // endDate > 5 years in future
  const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000
  const farEnd = baseValidPayload(addrs, now)
  farEnd.endDate = new Date(now.getTime() + fiveYearsMs + 86400 * 1000).toISOString()
  const res3 = validateCreateVault(farEnd, { now })
  assert.equal(res3.success, false)
  assert.ok(res3.details.some((d) => d.field === 'endDate' && (d.code === 'horizon_exceeded' || d.message.includes('5 years'))))
})

test('Validation: milestone title rules (non-empty trimmed <= 128 bytes, UTF-8 byte counting)', () => {
  const addrs = generateValidAddresses()
  const now = new Date()

  // Empty title
  const emptyTitle = baseValidPayload(addrs, now)
  emptyTitle.milestones[0].title = '   '
  const res1 = validateCreateVault(emptyTitle, { now })
  assert.equal(res1.success, false)
  assert.ok(res1.details.some((d) => d.field === 'milestones[0].title'))

  // Exactly 128 bytes title (passes)
  const ok128 = baseValidPayload(addrs, now)
  ok128.milestones[0].title = 'a'.repeat(128)
  const res2 = validateCreateVault(ok128, { now })
  assert.equal(res2.success, true)

  // 129 bytes ASCII (fails)
  const bad129 = baseValidPayload(addrs, now)
  bad129.milestones[0].title = 'a'.repeat(129)
  const res3 = validateCreateVault(bad129, { now })
  assert.equal(res3.success, false)
  assert.ok(res3.details.some((d) => d.field === 'milestones[0].title' && d.message.includes('128 bytes')))

  // Multi-byte emoji title: 32 emojis * 4 bytes = 128 bytes (passes)
  const emojiPass = baseValidPayload(addrs, now)
  emojiPass.milestones[0].title = '🚀'.repeat(32)
  assert.equal(Buffer.byteLength(emojiPass.milestones[0].title, 'utf8'), 128)
  const resEmojiPass = validateCreateVault(emojiPass, { now })
  assert.equal(resEmojiPass.success, true)

  // Multi-byte emoji title exceeding 128 bytes: 33 emojis * 4 bytes = 132 bytes (fails)
  const emojiFail = baseValidPayload(addrs, now)
  emojiFail.milestones[0].title = '🚀'.repeat(33)
  assert.equal(Buffer.byteLength(emojiFail.milestones[0].title, 'utf8'), 132)
  const resEmojiFail = validateCreateVault(emojiFail, { now })
  assert.equal(resEmojiFail.success, false)
  assert.ok(resEmojiFail.details.some((d) => d.field === 'milestones[0].title' && d.message.includes('128 bytes')))
})

test('Validation: milestone due date constraints (startDate < dueDate <= endDate, non-decreasing)', () => {
  const addrs = generateValidAddresses()
  const now = new Date()
  const start = new Date(now.getTime() + 3600 * 1000)
  const end = new Date(now.getTime() + 30 * 86400 * 1000)

  // dueDate before or equal to startDate
  const dueBeforeStart = baseValidPayload(addrs, now)
  dueBeforeStart.startDate = start.toISOString()
  dueBeforeStart.endDate = end.toISOString()
  dueBeforeStart.milestones[0].dueDate = new Date(start.getTime() - 1000).toISOString()
  dueBeforeStart.milestones[1].dueDate = new Date(start.getTime() + 5 * 86400 * 1000).toISOString()
  const res1 = validateCreateVault(dueBeforeStart, { now })
  assert.equal(res1.success, false)
  assert.ok(res1.details.some((d) => d.field === 'milestones[0].dueDate' && d.message.includes('after startDate')))

  // dueDate after endDate
  const dueAfterEnd = baseValidPayload(addrs, now)
  dueAfterEnd.startDate = start.toISOString()
  dueAfterEnd.endDate = end.toISOString()
  dueAfterEnd.milestones[0].dueDate = new Date(start.getTime() + 5 * 86400 * 1000).toISOString()
  dueAfterEnd.milestones[1].dueDate = new Date(end.getTime() + 1000).toISOString()
  const res2 = validateCreateVault(dueAfterEnd, { now })
  assert.equal(res2.success, false)
  assert.ok(res2.details.some((d) => d.field === 'milestones[1].dueDate' && d.message.includes('after endDate')))

  // Decreasing due dates: milestone 2 dueDate earlier than milestone 1
  const decreasingDue = baseValidPayload(addrs, now)
  decreasingDue.startDate = start.toISOString()
  decreasingDue.endDate = end.toISOString()
  decreasingDue.milestones[0].dueDate = new Date(start.getTime() + 10 * 86400 * 1000).toISOString()
  decreasingDue.milestones[1].dueDate = new Date(start.getTime() + 5 * 86400 * 1000).toISOString()
  const res3 = validateCreateVault(decreasingDue, { now })
  assert.equal(res3.success, false)
  assert.ok(res3.details.some((d) => d.field === 'milestones[1].dueDate' && (d.code === 'due_dates_decreasing' || d.message.includes('non-decreasing'))))

  // Non-decreasing due dates: milestone 1 and milestone 2 having equal dueDate passes
  const equalDue = baseValidPayload(addrs, now)
  equalDue.startDate = start.toISOString()
  equalDue.endDate = end.toISOString()
  const sameDue = new Date(start.getTime() + 10 * 86400 * 1000).toISOString()
  equalDue.milestones[0].dueDate = sameDue
  equalDue.milestones[1].dueDate = sameDue
  const resEqual = validateCreateVault(equalDue, { now })
  assert.equal(resEqual.success, true)
})

test('Validation: unknown top-level and milestone fields are rejected (.strict())', () => {
  const addrs = generateValidAddresses()
  const now = new Date()

  // Top-level unknown field
  const topUnknown = baseValidPayload(addrs, now)
  topUnknown.admin = true
  const res1 = validateCreateVault(topUnknown, { now })
  assert.equal(res1.success, false)
  assert.ok(res1.details.some((d) => d.field === 'admin' && d.code === 'unrecognized_keys'))

  // Milestone-level unknown field
  const msUnknown = baseValidPayload(addrs, now)
  msUnknown.milestones[0].extraField = 'malicious'
  const res2 = validateCreateVault(msUnknown, { now })
  assert.equal(res2.success, false)
  assert.ok(res2.details.some((d) => d.field === 'milestones[0].extraField' && d.code === 'unrecognized_keys'))
})

test('Validation: date timezone handling - treats strings without timezone as UTC', () => {
  const d1 = parseDateAsUtc('2026-07-15')
  assert.equal(d1.toISOString(), '2026-07-15T00:00:00.000Z')

  const d2 = parseDateAsUtc('2026-07-15T14:30:00')
  assert.equal(d2.toISOString(), '2026-07-15T14:30:00.000Z')

  const d3 = parseDateAsUtc('2026-07-15T14:30:00Z')
  assert.equal(d3.toISOString(), '2026-07-15T14:30:00.000Z')

  const d4 = parseDateAsUtc('2026-07-15T14:30:00+02:00')
  assert.equal(d4.toISOString(), '2026-07-15T12:30:00.000Z')

  assert.equal(parseDateAsUtc('not-a-date'), null)
})

test('Validation: does not echo raw input in error messages', () => {
  const addrs = generateValidAddresses()
  const now = new Date()
  const xssPayload = baseValidPayload(addrs, now)
  xssPayload.creator = '<script>alert("xss")</script>'

  const res = validateCreateVault(xssPayload, { now })
  assert.equal(res.success, false)
  for (const detail of res.details) {
    assert.ok(!detail.message.includes('<script>'), `Raw input echoed in error message: ${detail.message}`)
  }
})

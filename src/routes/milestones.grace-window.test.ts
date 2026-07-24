/**
 * Boundary tests for the check-in grace window feature.
 *
 * Covers:
 *  - just-before dueDate  → 200 OK
 *  - within grace window  → 200 OK
 *  - after grace window   → 400 DeadlinePassed
 *  - grace window capped by vault endDate → 400 DeadlinePassed
 *  - no dueDate set       → 200 OK (no deadline enforced)
 *  - zero grace window    → 400 immediately after dueDate
 */
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import { milestonesRouter } from './milestones.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { resetMilestonesTable, createMilestone } from '../services/milestones.js'
import { resetVaultStore } from '../services/vaultStore.js'
import { UserRole } from '../types/user.js'
import { setVaults } from './vaults.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

// auth.ts uses JWT_SECRET (defaults to 'change-me-in-production')
const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'
const verifierToken = jwt.sign(
  { userId: 'verifier-1', role: UserRole.VERIFIER },
  JWT_SECRET,
  { expiresIn: '1h' },
)

/** Returns an ISO string offset from now by `deltaMs` milliseconds. */
const fromNow = (deltaMs: number): string => new Date(Date.now() + deltaMs).toISOString()

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Build a minimal vault object for the legacy in-memory array. */
const makeVault = (
  id: string,
  opts: { endDate?: string; lateCheckInWindowSecs?: number } = {},
) => ({
  id,
  status: 'active',
  creator: 'creator-1',
  verifier: 'verifier-1',
  endDate: opts.endDate ?? fromNow(24 * HOUR),
  lateCheckInWindowSecs: opts.lateCheckInWindowSecs ?? 0,
})

// ── Test app setup ────────────────────────────────────────────────────────────

let baseUrl = ''
let server: ReturnType<express.Express['listen']> | null = null

const testApp = express()
testApp.use(express.json())
testApp.use('/:vaultId/milestones', milestonesRouter)
testApp.use(errorHandler)

beforeEach(async () => {
  resetMilestonesTable()
  resetVaultStore()
  setVaults([])

  server = testApp.listen(0)
  await new Promise<void>((resolve) => server!.once('listening', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) =>
    server!.close((err) => (err ? reject(err) : resolve())),
  )
  server = null
})

// ── Utility ───────────────────────────────────────────────────────────────────

const validate = (vaultId: string, milestoneId: string) =>
  fetch(`${baseUrl}/${vaultId}/milestones/${milestoneId}/validate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${verifierToken}`,
    },
  })

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('check-in grace window boundary tests', () => {
  test('just-before dueDate: accepts check-in (200)', async () => {
    const vaultId = 'vault-before'
    const dueDate = fromNow(5 * MINUTE) // due in 5 minutes
    setVaults([makeVault(vaultId, { lateCheckInWindowSecs: 0 })])
    const ms = createMilestone(vaultId, 'task', 'verifier-1', dueDate)

    const res = await validate(vaultId, ms.id)
    assert.equal(res.status, 200)
  })

  test('within grace window: accepts check-in (200)', async () => {
    const vaultId = 'vault-within-grace'
    const dueDate = fromNow(-30 * MINUTE) // due 30 min ago
    const graceWindowSecs = 3600 // 1 hour grace
    setVaults([makeVault(vaultId, { lateCheckInWindowSecs: graceWindowSecs })])
    const ms = createMilestone(vaultId, 'task', 'verifier-1', dueDate)

    const res = await validate(vaultId, ms.id)
    assert.equal(res.status, 200)
  })

  test('after grace window: rejects with DeadlinePassed (400)', async () => {
    const vaultId = 'vault-after-grace'
    const dueDate = fromNow(-2 * HOUR) // due 2 hours ago
    const graceWindowSecs = 3600 // 1 hour grace — already expired
    setVaults([makeVault(vaultId, { lateCheckInWindowSecs: graceWindowSecs })])
    const ms = createMilestone(vaultId, 'task', 'verifier-1', dueDate)

    const res = await validate(vaultId, ms.id)
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { message: string } }
    assert.match(body.error.message, /DeadlinePassed/i)
  })

  test('zero grace window: rejects immediately after dueDate (400)', async () => {
    const vaultId = 'vault-zero-grace'
    const dueDate = fromNow(-1 * MINUTE) // due 1 minute ago, no grace
    setVaults([makeVault(vaultId, { lateCheckInWindowSecs: 0 })])
    const ms = createMilestone(vaultId, 'task', 'verifier-1', dueDate)

    const res = await validate(vaultId, ms.id)
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { message: string } }
    assert.match(body.error.message, /DeadlinePassed/i)
  })

  test('grace window capped by vault endDate: rejects when endDate already passed (400)', async () => {
    const vaultId = 'vault-enddate-cap'
    const dueDate = fromNow(-30 * MINUTE) // due 30 min ago
    const endDate = fromNow(-10 * MINUTE) // vault ended 10 min ago (before grace expires)
    const graceWindowSecs = 3600 // 1 hour grace, but endDate caps it
    setVaults([makeVault(vaultId, { endDate, lateCheckInWindowSecs: graceWindowSecs })])
    const ms = createMilestone(vaultId, 'task', 'verifier-1', dueDate)

    const res = await validate(vaultId, ms.id)
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { message: string } }
    assert.match(body.error.message, /DeadlinePassed/i)
  })

  test('grace window within endDate: accepts check-in (200)', async () => {
    const vaultId = 'vault-grace-within-end'
    const dueDate = fromNow(-30 * MINUTE) // due 30 min ago
    const endDate = fromNow(2 * HOUR) // vault ends in 2 hours (grace fits)
    const graceWindowSecs = 3600 // 1 hour grace — still open
    setVaults([makeVault(vaultId, { endDate, lateCheckInWindowSecs: graceWindowSecs })])
    const ms = createMilestone(vaultId, 'task', 'verifier-1', dueDate)

    const res = await validate(vaultId, ms.id)
    assert.equal(res.status, 200)
  })

  test('no dueDate set: accepts check-in regardless of time (200)', async () => {
    const vaultId = 'vault-no-due'
    setVaults([makeVault(vaultId, { lateCheckInWindowSecs: 0 })])
    const ms = createMilestone(vaultId, 'task', 'verifier-1', null) // no dueDate

    const res = await validate(vaultId, ms.id)
    assert.equal(res.status, 200)
  })
})

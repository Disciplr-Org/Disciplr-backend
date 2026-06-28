/**
 * Tests for idempotent webhook subscriber upsert and signing-secret rotation.
 *
 * These tests require a PostgreSQL database (DATABASE_URL env var).  Without
 * it they are skipped gracefully so the suite still passes in CI environments
 * that run the unit-test-only job.
 *
 * Run locally:
 *   DATABASE_URL=postgres://... npx jest webhookSubscriber.rotation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import knex, { Knex } from 'knex'
import { WebhookSubscriberRepository } from '../repositories/webhookSubscriberRepository.js'

// ─── Conditional suite ────────────────────────────────────────────────────────

const hasDb = !!process.env.DATABASE_URL
const describeDb = hasDb ? describe : describe.skip

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_A = 'rotation-test-org-a'
const ORG_B = 'rotation-test-org-b'
const HOOK_URL = 'https://hooks.example.com/disciplr'

// ─── Suite ───────────────────────────────────────────────────────────────────

describeDb('WebhookSubscriberRepository – upsert & secret rotation', () => {
  let db: Knex
  let repo: WebhookSubscriberRepository

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    db = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL,
    })

    // Ensure the schema exists (mirrors what the migration creates)
    const hasTable = await db.schema.hasTable('webhook_subscribers')
    if (!hasTable) {
      await db.schema.createTable('webhook_subscribers', (t) => {
        t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
        t.string('organization_id', 255).notNullable()
        t.string('url', 2048).notNullable()
        t.text('secret').notNullable()
        t.text('previous_secret').nullable()
        t.timestamp('rotated_at', { useTz: true }).nullable()
        t.jsonb('events').notNullable().defaultTo(db.raw("'[]'::jsonb"))
        t.boolean('active').notNullable().defaultTo(true)
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
        t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
      })
      await db.raw(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_subscribers_org_url ON webhook_subscribers (organization_id, url)',
      )
    } else {
      // If the table exists, make sure the new columns are present (for envs
      // that ran an earlier migration but not the rotation one).
      const hasPrev = await db.schema.hasColumn('webhook_subscribers', 'previous_secret')
      if (!hasPrev) {
        await db.schema.alterTable('webhook_subscribers', (t) => {
          t.text('previous_secret').nullable()
          t.timestamp('rotated_at', { useTz: true }).nullable()
        })
        await db.raw(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_subscribers_org_url ON webhook_subscribers (organization_id, url)',
        )
      }
    }

    repo = new WebhookSubscriberRepository(db)
  })

  afterAll(async () => {
    await db.destroy()
  })

  beforeEach(async () => {
    // Isolate each test: only remove rows for the test orgs used in this suite
    await db('webhook_subscribers').whereIn('organization_id', [ORG_A, ORG_B]).del()
  })

  // ---------------------------------------------------------------------------
  // Idempotent upsert
  // ---------------------------------------------------------------------------

  describe('upsert()', () => {
    it('creates a new subscriber when none exists for the (org, url) pair', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'initial-secret',
        events: ['vault_created'],
      })

      expect(sub.id).toBeTruthy()
      expect(sub.organizationId).toBe(ORG_A)
      expect(sub.url).toBe(HOOK_URL)
      expect(sub.events).toEqual(['vault_created'])
      expect(sub.active).toBe(true)
      expect(sub.previousSecret).toBeNull()
      expect(sub.rotatedAt).toBeNull()
    })

    it('returns the same id on a second upsert for the same (org, url)', async () => {
      const first = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret-v1',
        events: [],
      })

      const second = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret-v2',
        events: ['vault_completed'],
      })

      expect(second.id).toBe(first.id)
    })

    it('updates secret and events on re-registration without creating duplicates', async () => {
      await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'old-secret',
        events: [],
      })

      await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'new-secret',
        events: ['vault_created', 'vault_completed'],
      })

      const all = await db('webhook_subscribers')
        .where({ organization_id: ORG_A, url: HOOK_URL })
        .select('*')

      // Must have exactly one row — no duplicates
      expect(all).toHaveLength(1)
      expect(all[0].secret).toBe('new-secret')
      expect(all[0].events).toEqual(['vault_created', 'vault_completed'])
    })

    it('re-activates a previously deactivated subscriber on upsert', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret',
        events: [],
      })

      await repo.deactivate(sub.id)
      expect((await repo.findByOrg(ORG_A))).toHaveLength(0)

      await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret',
        events: [],
      })

      const active = await repo.findByOrg(ORG_A)
      expect(active).toHaveLength(1)
      expect(active[0].active).toBe(true)
    })

    it('does not overwrite a different org's subscriber at the same URL', async () => {
      await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret-a',
        events: [],
      })

      await repo.upsert({
        organizationId: ORG_B,
        url: HOOK_URL,
        secret: 'secret-b',
        events: [],
      })

      const rowsA = await db('webhook_subscribers')
        .where({ organization_id: ORG_A, url: HOOK_URL })
        .select('secret')
      const rowsB = await db('webhook_subscribers')
        .where({ organization_id: ORG_B, url: HOOK_URL })
        .select('secret')

      expect(rowsA).toHaveLength(1)
      expect(rowsB).toHaveLength(1)
      // Org A's secret must remain untouched when org B upserts the same URL
      expect(rowsA[0].secret).toBe('secret-a')
      expect(rowsB[0].secret).toBe('secret-b')
    })

    it('preserves delivery history (dead letter rows) across re-registration', async () => {
      // Skip if dead_letters table is absent
      const hasDlq = await db.schema.hasTable('webhook_dead_letters')
      if (!hasDlq) return

      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret-v1',
        events: [],
      })

      // Plant a synthetic dead-letter keyed on the subscriber's id
      await db('webhook_dead_letters').insert({
        subscriber_id: sub.id,
        event_id: 'tx:history-0',
        event_type: 'vault_created',
        payload: { eventId: 'tx:history-0', eventType: 'vault_created', timestamp: new Date().toISOString(), data: {}, organizationId: ORG_A },
        last_error: 'simulated failure',
        attempts: 3,
      })

      // Re-register (upsert) — same id must survive
      const updated = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret-v2',
        events: ['vault_created'],
      })

      expect(updated.id).toBe(sub.id)

      const dlqRows = await db('webhook_dead_letters').where({ subscriber_id: sub.id })
      expect(dlqRows).toHaveLength(1)
      expect(dlqRows[0].event_id).toBe('tx:history-0')

      // Cleanup
      await db('webhook_dead_letters').where({ subscriber_id: sub.id }).del()
    })
  })

  // ---------------------------------------------------------------------------
  // rotateSecret()
  // ---------------------------------------------------------------------------

  describe('rotateSecret()', () => {
    it('moves current secret to previous_secret and sets rotated_at', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'original-secret',
        events: [],
      })

      const rotated = await repo.rotateSecret(sub.id, ORG_A, 'new-secret')

      expect(rotated).not.toBeNull()
      expect(rotated!.secret).toBe('new-secret')
      expect(rotated!.previousSecret).toBe('original-secret')
      expect(rotated!.rotatedAt).not.toBeNull()
    })

    it('returns null for a non-existent subscriber id', async () => {
      const result = await repo.rotateSecret(
        '00000000-0000-0000-0000-000000000000',
        ORG_A,
        'new-secret',
      )
      expect(result).toBeNull()
    })

    it('returns null (cross-org rejection) when org does not match', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret-a',
        events: [],
      })

      const result = await repo.rotateSecret(sub.id, ORG_B, 'attacker-secret')
      expect(result).toBeNull()

      // Confirm the row is unchanged
      const row = await db('webhook_subscribers').where({ id: sub.id }).first()
      expect(row.secret).toBe('secret-a')
    })

    it('overwrites previous_secret on a second rotation', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'v1',
        events: [],
      })

      await repo.rotateSecret(sub.id, ORG_A, 'v2')
      const second = await repo.rotateSecret(sub.id, ORG_A, 'v3')

      expect(second!.secret).toBe('v3')
      // previous_secret is now v2 (the secret that was active before v3)
      expect(second!.previousSecret).toBe('v2')
    })
  })

  // ---------------------------------------------------------------------------
  // Grace-window dual-secret verification (via isPreviousSecretInGrace)
  // ---------------------------------------------------------------------------

  describe('grace-window dual-secret verification', () => {
    // Import service helpers inline to avoid top-level import issues with
    // Jest module mocking in other test files.
    let signPayload: (secret: string, body: string) => string
    let verifySignatureWithGrace: (sub: any, body: string, sig: string) => boolean
    let isPreviousSecretInGrace: (sub: any) => boolean

    beforeAll(async () => {
      // Dynamic import so Jest module isolation in other suites is unaffected
      const mod = await import('../services/webhooks.js')
      signPayload = mod.signPayload
      verifySignatureWithGrace = mod.verifySignatureWithGrace
      isPreviousSecretInGrace = mod.isPreviousSecretInGrace
    })

    it('verifies with new secret immediately after rotation', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'old-secret',
        events: [],
      })
      const rotated = await repo.rotateSecret(sub.id, ORG_A, 'new-secret')

      const body = '{"hello":"world"}'
      const sig = signPayload('new-secret', body)

      expect(verifySignatureWithGrace(rotated!, body, sig)).toBe(true)
    })

    it('verifies with old secret during grace window', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'old-secret',
        events: [],
      })
      const rotated = await repo.rotateSecret(sub.id, ORG_A, 'new-secret')

      const body = '{"hello":"world"}'
      // Sign with the OLD secret (simulates an in-flight delivery)
      const oldSig = signPayload('old-secret', body)

      expect(verifySignatureWithGrace(rotated!, body, oldSig)).toBe(true)
    })

    it('rejects old secret after grace window has expired', async () => {
      // Simulate an expired rotation by back-dating rotated_at
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'old-secret',
        events: [],
      })
      const rotated = await repo.rotateSecret(sub.id, ORG_A, 'new-secret')

      // Back-date rotated_at to 48 h ago (beyond 24 h grace window)
      const expiredRotatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      const expiredSub = { ...rotated!, rotatedAt: expiredRotatedAt }

      const body = '{"hello":"world"}'
      const oldSig = signPayload('old-secret', body)

      // Grace window has closed – old secret should be rejected
      expect(isPreviousSecretInGrace(expiredSub)).toBe(false)
      expect(verifySignatureWithGrace(expiredSub, body, oldSig)).toBe(false)
    })

    it('verifies with new secret after grace window expires', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'old-secret',
        events: [],
      })
      const rotated = await repo.rotateSecret(sub.id, ORG_A, 'new-secret')

      const expiredRotatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      const expiredSub = { ...rotated!, rotatedAt: expiredRotatedAt }

      const body = '{"hello":"world"}'
      const newSig = signPayload('new-secret', body)

      expect(verifySignatureWithGrace(expiredSub, body, newSig)).toBe(true)
    })

    it('isPreviousSecretInGrace returns false when no previous secret', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'secret',
        events: [],
      })
      expect(isPreviousSecretInGrace(sub)).toBe(false)
    })

    it('respects WEBHOOK_SECRET_GRACE_WINDOW_MS env override', async () => {
      const sub = await repo.upsert({
        organizationId: ORG_A,
        url: HOOK_URL,
        secret: 'old-secret',
        events: [],
      })
      const rotated = await repo.rotateSecret(sub.id, ORG_A, 'new-secret')

      // Set a very short grace window (1 ms) then back-date by 1 second
      const originalEnv = process.env.WEBHOOK_SECRET_GRACE_WINDOW_MS
      process.env.WEBHOOK_SECRET_GRACE_WINDOW_MS = '1'

      const rotatedLongAgo = { ...rotated!, rotatedAt: new Date(Date.now() - 1000).toISOString() }

      expect(isPreviousSecretInGrace(rotatedLongAgo)).toBe(false)

      // Restore
      if (originalEnv === undefined) {
        delete process.env.WEBHOOK_SECRET_GRACE_WINDOW_MS
      } else {
        process.env.WEBHOOK_SECRET_GRACE_WINDOW_MS = originalEnv
      }
    })
  })
})

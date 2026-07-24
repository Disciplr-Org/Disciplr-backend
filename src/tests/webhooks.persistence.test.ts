import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import knex, { Knex } from 'knex'
import { WebhookSubscriberRepository } from '../repositories/webhookSubscriberRepository.js'

let db: Knex
let repo: WebhookSubscriberRepository

const ORG_A = 'org-a'
const ORG_B = 'org-b'

beforeAll(async () => {
  db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
  })

  const exists = await db.schema.hasTable('webhook_subscribers')
  if (!exists) {
    await db.schema.createTable('webhook_subscribers', (table) => {
      table.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'))
      table.string('organization_id', 255).notNullable()
      table.string('url', 2048).notNullable()
      table.text('secret').notNullable()
      table.jsonb('events').notNullable().defaultTo(db.raw("'[]'::jsonb"))
      table.boolean('active').notNullable().defaultTo(true)
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
    })
    await db.raw(
      'CREATE INDEX IF NOT EXISTS idx_webhook_subscribers_org_active ON webhook_subscribers (organization_id, active)',
    )
  }

  repo = new WebhookSubscriberRepository(db)
})

afterAll(async () => {
  await db.schema.dropTableIfExists('webhook_subscribers')
  await db.destroy()
})

beforeEach(async () => {
  await db('webhook_subscribers').del()
})

// ─── Restart durability ─────────────────────────────────────────────────────

describe('restart durability', () => {
  it('survives repository re-instantiation', async () => {
    const sub = await repo.create({
      organizationId: ORG_A,
      url: 'https://example.com/hook',
      secret: 's3cr3t',
      events: ['vault_created'],
    })

    const repo2 = new WebhookSubscriberRepository(db)
    const loaded = await repo2.findByOrg(ORG_A)

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(sub.id)
    expect(loaded[0].url).toBe('https://example.com/hook')
  })

  it('preserves data across simulated process restart', async () => {
    await repo.create({
      organizationId: ORG_A,
      url: 'https://hooks.example.com/callback',
      secret: 'my-secret',
      events: ['vault_completed', 'vault_failed'],
    })

    const freshDb = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL,
    })
    const freshRepo = new WebhookSubscriberRepository(freshDb)
    const loaded = await freshRepo.findByOrg(ORG_A)

    expect(loaded).toHaveLength(1)
    expect(loaded[0].events).toEqual(['vault_completed', 'vault_failed'])

    await freshDb.destroy()
  })
})

// ─── Organization isolation ─────────────────────────────────────────────────

describe('organization isolation', () => {
  it('returns only subscribers for the requested org', async () => {
    await repo.create({
      organizationId: ORG_A,
      url: 'https://org-a.example.com/hook',
      secret: 'secret-a',
      events: [],
    })
    await repo.create({
      organizationId: ORG_B,
      url: 'https://org-b.example.com/hook',
      secret: 'secret-b',
      events: [],
    })

    const orgASubs = await repo.findByOrg(ORG_A)
    expect(orgASubs).toHaveLength(1)
    expect(orgASubs[0].url).toBe('https://org-a.example.com/hook')

    const orgBSubs = await repo.findByOrg(ORG_B)
    expect(orgBSubs).toHaveLength(1)
    expect(orgBSubs[0].url).toBe('https://org-b.example.com/hook')
  })

  it('prevents cross-org event delivery', async () => {
    await repo.create({
      organizationId: ORG_A,
      url: 'https://org-a.example.com/hook',
      secret: 'secret-a',
      events: ['vault_created'],
    })
    await repo.create({
      organizationId: ORG_B,
      url: 'https://org-b.example.com/hook',
      secret: 'secret-b',
      events: ['vault_created'],
    })

    const orgAEventSubs = await repo.findByEvent(ORG_A, 'vault_created')
    expect(orgAEventSubs).toHaveLength(1)
    expect(orgAEventSubs[0].url).toContain('org-a')

    const orgBEventSubs = await repo.findByEvent(ORG_B, 'vault_created')
    expect(orgBEventSubs).toHaveLength(1)
    expect(orgBEventSubs[0].url).toContain('org-b')
  })
})

// ─── Active flag behavior ───────────────────────────────────────────────────

describe('active flag', () => {
  it('excludes deactivated subscribers from queries', async () => {
    const sub = await repo.create({
      organizationId: ORG_A,
      url: 'https://example.com/hook',
      secret: 'secret',
      events: ['vault_created'],
    })

    expect(await repo.findByOrg(ORG_A)).toHaveLength(1)

    await repo.deactivate(sub.id)
    expect(await repo.findByOrg(ORG_A)).toHaveLength(0)
    expect(await repo.findByEvent(ORG_A, 'vault_created')).toHaveLength(0)
  })

  it('allows re-activation after deactivation', async () => {
    const sub = await repo.create({
      organizationId: ORG_A,
      url: 'https://example.com/hook',
      secret: 'secret',
      events: [],
    })

    await repo.deactivate(sub.id)
    expect(await repo.findByOrg(ORG_A)).toHaveLength(0)

    await db('webhook_subscribers').where({ id: sub.id }).update({ active: true })
    const restored = await repo.findByOrg(ORG_A)
    expect(restored).toHaveLength(1)
    expect(restored[0].active).toBe(true)
  })
})

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty events array as wildcard', async () => {
    await repo.create({
      organizationId: ORG_A,
      url: 'https://example.com/hook',
      secret: 'secret',
      events: [],
    })

    const forVaultCreated = await repo.findByEvent(ORG_A, 'vault_created')
    expect(forVaultCreated).toHaveLength(1)

    const forVaultCompleted = await repo.findByEvent(ORG_A, 'vault_completed')
    expect(forVaultCompleted).toHaveLength(1)
  })

  it('allows duplicate URLs across different organizations', async () => {
    const url = 'https://example.com/hook'

    const subA = await repo.create({
      organizationId: ORG_A,
      url,
      secret: 'secret-a',
      events: [],
    })
    const subB = await repo.create({
      organizationId: ORG_B,
      url,
      secret: 'secret-b',
      events: [],
    })

    expect(subA.id).not.toBe(subB.id)
    expect(await repo.findByOrg(ORG_A)).toHaveLength(1)
    expect(await repo.findByOrg(ORG_B)).toHaveLength(1)
  })

  it('returns empty list for org with no subscribers', async () => {
    const subs = await repo.findByOrg('non-existent-org')
    expect(subs).toEqual([])
  })

  it('returns empty list for event type with no matching subscribers', async () => {
    await repo.create({
      organizationId: ORG_A,
      url: 'https://example.com/hook',
      secret: 'secret',
      events: ['vault_created'],
    })

    const subs = await repo.findByEvent(ORG_A, 'vault_cancelled')
    expect(subs).toEqual([])
  })

  it('handles removal of non-existent subscriber gracefully', async () => {
    const result = await repo.remove('00000000-0000-0000-0000-000000000000')
    expect(result).toBe(false)
  })

  it('handles deactivation of non-existent subscriber gracefully', async () => {
    const result = await repo.deactivate('00000000-0000-0000-0000-000000000000')
    expect(result).toBe(false)
  })
})

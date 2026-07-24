/**
 * Tests: per-org webhook egress allowlist enforcement (issue #877)
 *
 * Coverage:
 *  - Registration rejected for off-allowlist host
 *  - Registration allowed for on-allowlist host (including subdomain)
 *  - No-allowlist = baseline SSRF guard only
 *  - Delivery blocked after host removed from allowlist
 *  - Baseline SSRF guard still applies even with an allowlist configured
 *  - dispatchWebhookEvent respects the allowlist at delivery time
 *  - replayDeadLetter respects the allowlist
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { randomUUID } from 'node:crypto'
import type { WebhookSubscriber, WebhookDeliveryPayload } from '../services/webhooks.js'

// ── In-memory egress allowlist store ────────────────────────────────────────

const egressAllowlists = new Map<string, Set<string>>()

const getAllowlistHosts = (orgId: string): string[] =>
  [...(egressAllowlists.get(orgId) ?? [])]

// ── Mock DB (only the tables touched by the allowlist feature) ───────────────

jest.unstable_mockModule('../db/index.js', () => {
  const buildQuery = (table: string) => {
    const q: any = {
      _table: table,
      _filters: {} as Record<string, any>,
      _data: null as any,

      where(filter: Record<string, any>) {
        Object.assign(q._filters, filter)
        return q
      },
      select() { return q },
      orderBy() { return q },

      // INSERT … ON CONFLICT … MERGE … RETURNING
      insert(data: any) {
        q._data = data
        return q
      },
      onConflict() { return q },
      merge(d: any) { if (d) q._data = { ...q._data, ...d }; return q },
      async returning() {
        if (q._table === 'org_webhook_egress_allowlists') {
          const orgId = q._data.organization_id
          const host = q._data.host
          let set = egressAllowlists.get(orgId)
          if (!set) { set = new Set<string>(); egressAllowlists.set(orgId, set) }
          set.add(host)
          return [{ id: randomUUID(), organization_id: orgId, host, created_at: new Date() }]
        }
        return [{ id: randomUUID(), ...q._data }]
      },

      // DELETE
      async del() {
        if (q._table === 'org_webhook_egress_allowlists') {
          const orgId = q._filters.organization_id
          const host = q._filters.host
          const set = egressAllowlists.get(orgId)
          if (set?.has(host)) { set.delete(host); return 1 }
          return 0
        }
        return 0
      },

      // For plain insert (no .returning()) e.g. dead_letters
      then(resolve: (v: any) => any, reject?: (e: any) => any) {
        if (q._table === 'org_webhook_egress_allowlists') {
          const orgId = q._filters.organization_id
          const rows = getAllowlistHosts(orgId).map((host) => ({
            id: randomUUID(),
            organization_id: orgId,
            host,
            created_at: new Date(),
          }))
          return Promise.resolve(rows).then(resolve, reject)
        }
        // For webhook_dead_letters insert and any other table, resolve with 1
        return Promise.resolve(1).then(resolve, reject)
      },
    }
    return q
  }

  const db: any = jest.fn((table: string) => buildQuery(table))
  db.fn = { now: () => new Date() }
  db.raw = jest.fn()
  return { db }
})

jest.unstable_mockModule('../db/knex.js', () => ({
  db: {} as any,
  closeDatabase: jest.fn(),
}))

// ── In-memory subscriber store for the repo mock ─────────────────────────────

const mockSubscribers: WebhookSubscriber[] = []

jest.unstable_mockModule('../repositories/webhookSubscriberRepository.js', () => ({
  WebhookSubscriberRepository: jest.fn().mockImplementation(() => ({
    findByOrg: jest.fn(async (orgId: string) =>
      mockSubscribers.filter((s) => s.organizationId === orgId && s.active),
    ),
    findByEvent: jest.fn(async (orgId: string, eventType: string) =>
      mockSubscribers.filter(
        (s) =>
          s.organizationId === orgId &&
          s.active &&
          (s.events.length === 0 || s.events.includes(eventType)),
      ),
    ),
    findById: jest.fn(async (id: string) => mockSubscribers.find((s) => s.id === id) ?? null),
    create: jest.fn(
      async (data: {
        organizationId: string
        url: string
        secret: string
        events: string[]
        schemaVersion?: number
      }): Promise<WebhookSubscriber> => {
        const sub: WebhookSubscriber = {
          id: randomUUID(),
          organizationId: data.organizationId,
          url: data.url,
          secret: data.secret,
          previousSecret: null,
          rotatedAt: null,
          events: [...data.events],
          active: true,
          schemaVersion: data.schemaVersion ?? 1,
          createdAt: new Date().toISOString(),
        }
        mockSubscribers.push(sub)
        return sub
      },
    ),
    upsert: jest.fn(
      async (data: { organizationId: string; url: string; secret: string; events: string[] }) => {
        const existing = mockSubscribers.find(
          (s) => s.organizationId === data.organizationId && s.url === data.url,
        )
        if (existing) {
          existing.secret = data.secret
          existing.events = [...data.events]
          return existing
        }
        const sub: WebhookSubscriber = {
          id: randomUUID(),
          organizationId: data.organizationId,
          url: data.url,
          secret: data.secret,
          previousSecret: null,
          rotatedAt: null,
          events: [...data.events],
          active: true,
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        }
        mockSubscribers.push(sub)
        return sub
      },
    ),
    remove: jest.fn(async (id: string): Promise<boolean> => {
      const idx = mockSubscribers.findIndex((s) => s.id === id)
      if (idx !== -1) { mockSubscribers.splice(idx, 1); return true }
      return false
    }),
    getBreakerState: jest.fn(async () => null),
    upsertBreakerState: jest.fn(async () => {}),
    tryTransitionToHalfOpen: jest.fn(async () => false),
    removeBreakerState: jest.fn(async () => true),
    getAllBreakerStates: jest.fn(async () => []),
  })),
}))

// ── Load SUT after mocks are registered ──────────────────────────────────────

const {
  addSubscriber,
  upsertSubscriber,
  addEgressAllowlistEntry,
  removeEgressAllowlistEntry,
  dispatchWebhookEvent,
  replayDeadLetter,
  resetSubscribers,
  resetBreakerCache,
} = await import('../services/webhooks.js')

const ORG = 'org-allowlist-test'
const OTHER_ORG = 'org-no-allowlist'

const PAYLOAD: WebhookDeliveryPayload = {
  eventId: 'tx:1',
  eventType: 'vault_created',
  timestamp: '2026-06-27T00:00:00.000Z',
  data: { vaultId: 'v-1' },
  organizationId: ORG,
}

beforeEach(async () => {
  mockSubscribers.length = 0
  egressAllowlists.clear()
  resetBreakerCache()
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('egress allowlist — registration enforcement', () => {
  it('rejects addSubscriber when org has an allowlist and host is not on it', async () => {
    await addEgressAllowlistEntry(ORG, 'allowed.example.com')

    await expect(
      addSubscriber(ORG, 'https://evil.example.com/hook', 'secret', ['vault_created']),
    ).rejects.toThrow(/egress allowlist/i)
  })

  it('allows addSubscriber when host is on the allowlist', async () => {
    await addEgressAllowlistEntry(ORG, 'allowed.example.com')

    const sub = await addSubscriber(ORG, 'https://allowed.example.com/hook', 'secret', ['vault_created'])
    expect(sub.url).toBe('https://allowed.example.com/hook')
  })

  it('allows subdomain of an allowlisted host', async () => {
    await addEgressAllowlistEntry(ORG, 'example.com')

    const sub = await addSubscriber(ORG, 'https://hooks.example.com/cb', 'secret', ['vault_created'])
    expect(sub.url).toBe('https://hooks.example.com/cb')
  })

  it('allows any allowed-SSRF host when org has no allowlist', async () => {
    // OTHER_ORG has no allowlist — only SSRF guard applies
    const sub = await addSubscriber(OTHER_ORG, 'https://any-valid.example.com/hook', 'secret', [])
    expect(sub.url).toBe('https://any-valid.example.com/hook')
  })

  it('rejects upsertSubscriber when org has an allowlist and host is not on it', async () => {
    await addEgressAllowlistEntry(ORG, 'allowed.example.com')

    await expect(
      upsertSubscriber(ORG, 'https://not-allowed.example.com/hook', 'secret', []),
    ).rejects.toThrow(/egress allowlist/i)
  })

  it('baseline SSRF guard still applies when an allowlist is configured', async () => {
    // Even if 169.254.169.254 were somehow on the list, the SSRF guard fires first.
    await addEgressAllowlistEntry(ORG, '169.254.169.254')

    await expect(
      addSubscriber(ORG, 'http://169.254.169.254/latest/meta-data', 'secret', []),
    ).rejects.toThrow(/not permitted/i)
  })
})

describe('egress allowlist — delivery-time enforcement', () => {
  it('blocks delivery after the host is removed from the allowlist', async () => {
    // Add two entries so the allowlist stays non-empty after removing hooks.example.com
    await addEgressAllowlistEntry(ORG, 'hooks.example.com')
    await addEgressAllowlistEntry(ORG, 'other.example.com')
    await addSubscriber(ORG, 'https://hooks.example.com/cb', 'secret', ['vault_created'])

    // Remove the subscriber's host — allowlist still exists (other.example.com remains)
    await removeEgressAllowlistEntry(ORG, 'hooks.example.com')

    const fetchMock = jest.fn<typeof fetch>()
    global.fetch = fetchMock as any

    const results = await dispatchWebhookEvent(PAYLOAD)

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
    expect(results[0].error).toMatch(/egress allowlist/i)
    // No HTTP request should have been made
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('delivers when org has no allowlist (baseline behaviour)', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      status: 200,
      headers: new Headers(),
    } as Response)
    global.fetch = fetchMock as any

    await addSubscriber(OTHER_ORG, 'https://hooks.example.com/cb', 'secret', ['vault_created'])

    const results = await dispatchWebhookEvent({ ...PAYLOAD, organizationId: OTHER_ORG })

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('baseline SSRF guard applies even during delivery with an allowlist', async () => {
    // Manually push an "already registered" subscriber with an SSRF URL
    // (simulating a row that was registered before the SSRF guard was added)
    mockSubscribers.push({
      id: 'sub-ssrf',
      organizationId: ORG,
      url: 'http://169.254.169.254/hook',
      secret: 'secret',
      previousSecret: null,
      rotatedAt: null,
      events: ['vault_created'],
      active: true,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    })
    await addEgressAllowlistEntry(ORG, '169.254.169.254')

    const fetchMock = jest.fn<typeof fetch>()
    global.fetch = fetchMock as any

    const results = await dispatchWebhookEvent(PAYLOAD)

    expect(results[0].success).toBe(false)
    expect(results[0].error).toMatch(/not permitted/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('egress allowlist — replayDeadLetter enforcement', () => {
  it('blocks replay when host has been removed from the allowlist', async () => {
    // Add two entries so the allowlist stays non-empty after removing hooks.example.com
    await addEgressAllowlistEntry(ORG, 'hooks.example.com')
    await addEgressAllowlistEntry(ORG, 'other.example.com')
    const sub = await addSubscriber(ORG, 'https://hooks.example.com/cb', 'secret', ['vault_created'])

    // Remove subscriber's host — allowlist still exists (other.example.com remains)
    await removeEgressAllowlistEntry(ORG, 'hooks.example.com')

    // Verify that isUrlAllowedForOrg now rejects the URL
    const { isUrlAllowedForOrg } = await import('../services/webhooks.js')
    const check = await isUrlAllowedForOrg(ORG, sub.url)
    expect(check.allowed).toBe(false)
    expect(check.reason).toMatch(/allowlist/i)
  })

  it('allows replay when host is on the allowlist', async () => {
    await addEgressAllowlistEntry(ORG, 'hooks.example.com')

    const { isUrlAllowedForOrg } = await import('../services/webhooks.js')
    const check = await isUrlAllowedForOrg(ORG, 'https://hooks.example.com/cb')
    expect(check.allowed).toBe(true)
  })
})

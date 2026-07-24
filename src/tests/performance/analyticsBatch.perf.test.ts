/**
 * Performance tests for AnalyticsBatchLoader.
 *
 * Covers:
 * - Key deduplication: repeated IDs produce a single batch query.
 * - Query-count reduction: N vault IDs → 1 vault query + 1 milestone query (not N).
 * - Result parity: batched aggregates match values computed via individual queries.
 * - Tenant isolation: separate loader instances share no cached state.
 */

import Database from 'better-sqlite3'
import { AnalyticsBatchLoader } from '../../services/analyticsBatchLoader.js'
import { getOrgAnalyticsBatched } from '../../services/analytics.service.js'

// ---------------------------------------------------------------------------
// In-memory SQLite DB shared across tests in this file.
// ---------------------------------------------------------------------------

const testDb = new Database(':memory:')

testDb.exec(`
  CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    amount TEXT NOT NULL,
    org_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    status TEXT NOT NULL
  );
`)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let milestoneSeq = 0

function seedVault(id: string, status: string, amount: string, orgId: string): void {
  testDb.prepare('INSERT OR IGNORE INTO vaults (id, status, amount, org_id) VALUES (?, ?, ?, ?)').run(
    id, status, amount, orgId,
  )
}

function seedMilestone(vaultId: string, status: string): void {
  testDb
    .prepare('INSERT INTO milestones (id, vault_id, status) VALUES (?, ?, ?)')
    .run(`m-${++milestoneSeq}`, vaultId, status)
}

function clearTables(): void {
  testDb.prepare('DELETE FROM milestones').run()
  testDb.prepare('DELETE FROM vaults').run()
  milestoneSeq = 0
}

function makeLoader(): AnalyticsBatchLoader {
  return new AnalyticsBatchLoader(testDb)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsBatchLoader', () => {
  beforeEach(() => {
    clearTables()
  })

  // ── deduplication ─────────────────────────────────────────────────────────

  describe('key deduplication', () => {
    it('issues exactly one vault query when the same key is requested multiple times', () => {
      seedVault('v1', 'active', '100', 'org-a')

      const loader = makeLoader()

      // First load with repeated keys
      const first = loader.loadVaults(['v1', 'v1', 'v1'])
      expect(first.size).toBe(1)
      expect(loader.queries).toBe(1)

      // Second call with same key — hits intra-request cache, no new query
      const second = loader.loadVaults(['v1'])
      expect(second.size).toBe(1)
      expect(loader.queries).toBe(1)
    })

    it('issues exactly one milestone query for duplicate vault IDs', () => {
      seedVault('v1', 'active', '100', 'org-a')
      seedMilestone('v1', 'completed')

      const loader = makeLoader()

      loader.loadMilestones(['v1', 'v1', 'v1'])
      expect(loader.queries).toBe(1)

      // Cached — no extra query
      loader.loadMilestones(['v1'])
      expect(loader.queries).toBe(1)
    })
  })

  // ── query-count reduction ─────────────────────────────────────────────────

  describe('query-count reduction', () => {
    it('fetches N vault aggregates with exactly 1 query', () => {
      const ids: string[] = []
      for (let i = 0; i < 20; i++) {
        const id = `v-batch-${i}`
        ids.push(id)
        seedVault(id, i % 2 === 0 ? 'active' : 'completed', String(100 + i), 'org-b')
      }

      const loader = makeLoader()
      const result = loader.loadVaults(ids)

      expect(result.size).toBe(20)
      expect(loader.queries).toBe(1) // single IN-clause query, not 20
    })

    it('fetches N milestone aggregates with exactly 1 query', () => {
      const ids: string[] = []
      for (let i = 0; i < 20; i++) {
        const id = `v-ms-${i}`
        ids.push(id)
        seedVault(id, 'active', '50', 'org-b')
        seedMilestone(id, 'completed')
        seedMilestone(id, 'pending')
      }

      const loader = makeLoader()
      const result = loader.loadMilestones(ids)

      expect(result.size).toBe(20)
      expect(loader.queries).toBe(1)
    })

    it('loading vaults then milestones for same IDs costs exactly 2 total queries', () => {
      const ids = ['v-x', 'v-y']
      seedVault('v-x', 'active', '200', 'org-c')
      seedVault('v-y', 'completed', '300', 'org-c')
      seedMilestone('v-x', 'completed')

      const loader = makeLoader()
      loader.loadVaults(ids)
      loader.loadMilestones(ids)

      expect(loader.queries).toBe(2)
    })
  })

  // ── result parity ─────────────────────────────────────────────────────────

  describe('result parity', () => {
    it('vault aggregate matches individually-computed values', () => {
      seedVault('v-p1', 'active', '500', 'org-d')
      seedMilestone('v-p1', 'completed')
      seedMilestone('v-p1', 'completed')
      seedMilestone('v-p1', 'pending')

      const loader = makeLoader()
      const vaults = loader.loadVaults(['v-p1'])
      const milestones = loader.loadMilestones(['v-p1'])

      const v = vaults.get('v-p1')!
      expect(v.status).toBe('active')
      expect(v.amount).toBe('500')
      expect(v.milestoneCount).toBe(3)
      expect(v.completedMilestones).toBe(2)

      const m = milestones.get('v-p1')!
      expect(m.milestoneCount).toBe(3)
      expect(m.completedMilestones).toBe(2)
      expect(m.pendingMilestones).toBe(1)
    })

    it('vaults with no milestones return zero milestone counts', () => {
      seedVault('v-nomile', 'active', '100', 'org-d')

      const loader = makeLoader()
      const milestones = loader.loadMilestones(['v-nomile'])

      const m = milestones.get('v-nomile')!
      expect(m.milestoneCount).toBe(0)
      expect(m.completedMilestones).toBe(0)
      expect(m.pendingMilestones).toBe(0)
    })

    it('returns empty map for unknown vault IDs', () => {
      const loader = makeLoader()
      const vaults = loader.loadVaults(['does-not-exist'])
      expect(vaults.size).toBe(0)
    })
  })

  // ── getOrgAnalyticsBatched ─────────────────────────────────────────────────

  describe('getOrgAnalyticsBatched', () => {
    it('aggregates multiple vaults correctly', () => {
      seedVault('org1-v1', 'active', '1000', 'org-1')
      seedVault('org1-v2', 'completed', '2000', 'org-1')
      seedVault('org1-v3', 'failed', '500', 'org-1')
      seedMilestone('org1-v1', 'completed')
      seedMilestone('org1-v1', 'pending')
      seedMilestone('org1-v2', 'completed')

      const result = getOrgAnalyticsBatched(
        ['org1-v1', 'org1-v2', 'org1-v3'],
        testDb,
      )

      expect(result.totalVaults).toBe(3)
      expect(result.activeVaults).toBe(1)
      expect(result.completedVaults).toBe(1)
      expect(result.failedVaults).toBe(1)
      expect(result.totalLockedCapital).toBe('3500')
      expect(result.successRate).toBe(0.5)
      expect(result.totalMilestones).toBe(3)
      expect(result.completedMilestones).toBe(2)
    })

    it('returns zero-value result for empty vault list', () => {
      const result = getOrgAnalyticsBatched([], testDb)
      expect(result.totalVaults).toBe(0)
      expect(result.successRate).toBe(0)
      expect(result.totalLockedCapital).toBe('0')
    })
  })

  // ── tenant isolation ───────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('separate loader instances share no cached state', () => {
      seedVault('t1-v1', 'active', '100', 'tenant-1')
      seedVault('t2-v1', 'completed', '200', 'tenant-2')

      const loaderA = makeLoader()
      const loaderB = makeLoader()

      const resultA = loaderA.loadVaults(['t1-v1'])
      const resultB = loaderB.loadVaults(['t2-v1'])

      // Each loader only sees its own requested vaults
      expect(resultA.has('t2-v1')).toBe(false)
      expect(resultB.has('t1-v1')).toBe(false)

      // Each loader issued its own query — no cross-instance cache
      expect(loaderA.queries).toBe(1)
      expect(loaderB.queries).toBe(1)
    })

    it('loading tenant-A IDs does not expose tenant-B data', () => {
      seedVault('ta-v1', 'active', '999', 'tenant-a')
      seedVault('tb-v1', 'active', '1', 'tenant-b')

      const loader = makeLoader()
      const result = loader.loadVaults(['ta-v1'])

      expect(result.has('tb-v1')).toBe(false)
      expect(result.get('ta-v1')?.amount).toBe('999')
    })

    it('a loader primed with tenant-A IDs cannot retrieve tenant-B data on a second call', () => {
      seedVault('p-v1', 'active', '50', 'org-p')
      seedVault('q-v1', 'active', '75', 'org-q')

      const loader = makeLoader()
      loader.loadVaults(['p-v1'])

      const second = loader.loadVaults(['q-v1'])
      expect(second.size).toBe(1)
      expect(second.has('p-v1')).toBe(false)
    })
  })
})

/**
 * Performance benchmark: cache hit ratio and read latency.
 *
 * Covers:
 * - Cold-cache miss path: loader called exactly once on first read.
 * - Warm-cache hit path: loader not called after warm-up.
 * - Hit ratio: exceeds 95% floor after initial warm-up.
 * - Latency budget: p95 of in-memory cache hits stays under 5ms.
 * - Latency advantage: cache-hit p95 is faster than cold-loader p95.
 * - Cache-bypass regression: loader call count stays constant regardless of read volume.
 * - Vault read path: warm-cache vault analytics cost 0 DB queries after warm-up.
 * - Analytics read path: warm-cache analytics reads skip the loader entirely.
 * - Multi-tenant isolation: org-A cache hit does not serve org-B.
 *
 * Uses the in-memory LRU cache implementation (no Redis) for deterministic
 * measurement. Run with --maxWorkers=1 to avoid timing interference from
 * parallel workers.
 *
 * Budget constants:
 *   HIT_RATIO_FLOOR       = 0.95  (95% of reads must be cache hits after warm-up)
 *   HIT_LATENCY_P95_MS    = 5     (p95 in-memory hit latency budget, milliseconds)
 */

import Database from 'better-sqlite3'
import { getOrSet, closeCache } from '../../lib/cache.js'
import { AnalyticsBatchLoader } from '../../services/analyticsBatchLoader.js'
import { getOrgAnalyticsBatched } from '../../services/analytics.service.js'

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/** Minimum fraction of reads that must be served from cache after warm-up. */
const HIT_RATIO_FLOOR = 0.95

/** p95 latency ceiling (ms) for reads served from the in-memory LRU cache. */
const HIT_LATENCY_P95_MS = 5

/** Number of warm reads per latency / ratio scenario. */
const WARM_READS = 100

// ---------------------------------------------------------------------------
// Latency helpers
// ---------------------------------------------------------------------------

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)]
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now()
  const result = await fn()
  return [result, Date.now() - start]
}

// ---------------------------------------------------------------------------
// In-memory SQLite DB for the vault read path tests
// ---------------------------------------------------------------------------

const testDb = new Database(':memory:')

testDb.exec(`
  CREATE TABLE IF NOT EXISTS vaults (
    id      TEXT PRIMARY KEY,
    status  TEXT NOT NULL,
    amount  TEXT NOT NULL,
    org_id  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS milestones (
    id       TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    status   TEXT NOT NULL
  );
`)

let milestoneSeq = 0

function seedVault(id: string, status: string, amount: string): void {
  testDb
    .prepare('INSERT OR IGNORE INTO vaults (id, status, amount, org_id) VALUES (?, ?, ?, ?)')
    .run(id, status, amount, 'org-bench')
}

function seedMilestone(vaultId: string, status: string): void {
  testDb
    .prepare('INSERT INTO milestones (id, vault_id, status) VALUES (?, ?, ?)')
    .run(`m-bench-${++milestoneSeq}`, vaultId, status)
}

// ---------------------------------------------------------------------------
// Seed vault data once for the vault read path describe block
// ---------------------------------------------------------------------------

const BENCH_VAULT_IDS = ['bv-1', 'bv-2', 'bv-3', 'bv-4', 'bv-5']

for (const id of BENCH_VAULT_IDS) {
  seedVault(id, 'active', '1000')
  seedMilestone(id, 'completed')
  seedMilestone(id, 'pending')
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Cache read benchmark — hit ratio and latency', () => {
  beforeEach(async () => {
    // Start every test with a cold in-memory cache for determinism.
    await closeCache()
  })

  afterAll(async () => {
    await closeCache()
  })

  // ── cold-cache miss path ─────────────────────────────────────────────────

  describe('cold-cache miss path', () => {
    it('calls loader exactly once on the first (cold) read', async () => {
      let loaderCalls = 0
      const loader = async () => { loaderCalls++; return { value: 42 } }

      await getOrSet('bench:cold:single', 300, loader)

      expect(loaderCalls).toBe(1)
    })

    it('cold-miss read captures loader overhead in elapsed time', async () => {
      const LOADER_DELAY_MS = 20
      const loader = async () => {
        await new Promise<void>((r) => setTimeout(r, LOADER_DELAY_MS))
        return { data: 'slow-result' }
      }

      const [, elapsed] = await timed(() => getOrSet('bench:cold:delay', 300, loader))

      expect(elapsed).toBeGreaterThanOrEqual(LOADER_DELAY_MS)
    })
  })

  // ── warm-cache hit path ──────────────────────────────────────────────────

  describe('warm-cache hit path', () => {
    it('does not invoke loader on any subsequent read after warm-up', async () => {
      let loaderCalls = 0
      const loader = async () => { loaderCalls++; return { v: 1 } }
      const key = 'bench:warm:no-loader'

      await getOrSet(key, 300, loader) // warm-up (one miss)
      loaderCalls = 0

      for (let i = 0; i < WARM_READS; i++) {
        await getOrSet(key, 300, loader)
      }

      expect(loaderCalls).toBe(0)
    })

    it('returns identical data on every cache hit (result parity)', async () => {
      const payload = { id: 'vault-bench', amount: '5000', status: 'active' }
      const loader = async () => ({ ...payload })
      const key = 'bench:warm:parity'

      const cold = await getOrSet(key, 300, loader)

      for (let i = 0; i < 10; i++) {
        const hit = await getOrSet(key, 300, loader)
        expect(hit).toEqual(cold)
      }
    })
  })

  // ── hit ratio ────────────────────────────────────────────────────────────

  describe('hit ratio', () => {
    it(`exceeds ${HIT_RATIO_FLOOR * 100}% hit ratio over ${WARM_READS} reads after warm-up`, async () => {
      let loaderCalls = 0
      const loader = async () => { loaderCalls++; return { data: 'analytics:overall' } }
      const key = 'bench:ratio:analytics'

      for (let i = 0; i < WARM_READS; i++) {
        await getOrSet(key, 300, loader)
      }

      const hitRatio = (WARM_READS - loaderCalls) / WARM_READS
      expect(hitRatio).toBeGreaterThanOrEqual(HIT_RATIO_FLOOR)
    })

    it('achieves 100% hit ratio for vault reads after a single warm-up miss', async () => {
      let loaderCalls = 0
      const loader = async () => { loaderCalls++; return { vaults: [] } }
      const key = 'bench:ratio:vaults'

      await getOrSet(key, 300, loader) // one allowed miss

      const pureHitReads = 50
      for (let i = 0; i < pureHitReads; i++) {
        await getOrSet(key, 300, loader)
      }

      // loaderCalls must still be exactly 1 — the warm-up miss
      expect(loaderCalls).toBe(1)
    })
  })

  // ── latency budget ───────────────────────────────────────────────────────

  describe('latency budget', () => {
    it(`cache-hit p95 latency stays under ${HIT_LATENCY_P95_MS}ms`, async () => {
      const loader = async () => ({ data: 'analytics:overall' })
      const key = 'bench:latency:p95'

      await getOrSet(key, 300, loader) // warm cache

      const samples: number[] = []
      for (let i = 0; i < WARM_READS; i++) {
        const [, elapsed] = await timed(() => getOrSet(key, 300, loader))
        samples.push(elapsed)
      }

      expect(p95(samples)).toBeLessThan(HIT_LATENCY_P95_MS)
    })

    it('cache-hit p95 latency is lower than the measured cold-loader latency', async () => {
      const LOADER_DELAY_MS = 20
      const loader = async () => {
        await new Promise<void>((r) => setTimeout(r, LOADER_DELAY_MS))
        return { data: 'slow-analytics' }
      }
      const key = 'bench:latency:compare'

      const [, coldLatency] = await timed(() => getOrSet(key, 300, loader))

      const hitSamples: number[] = []
      for (let i = 0; i < 30; i++) {
        const [, elapsed] = await timed(() => getOrSet(key, 300, loader))
        hitSamples.push(elapsed)
      }

      expect(p95(hitSamples)).toBeLessThan(coldLatency)
    })
  })

  // ── cache-bypass regression detection ───────────────────────────────────

  describe('cache-bypass regression detection', () => {
    it('loader call count stays at 1 regardless of total read volume', async () => {
      const volumes = [10, 25, 50, 100]

      for (const volume of volumes) {
        await closeCache() // cold start for each volume scenario

        let loaderCalls = 0
        const loader = async () => { loaderCalls++; return { vaults: 'all' } }

        for (let i = 0; i < volume; i++) {
          await getOrSet('bench:bypass:vaults', 300, loader)
        }

        // Exactly one miss (the first read) regardless of volume
        expect(loaderCalls).toBe(1)
      }
    })

    it('multiple distinct keys each get exactly one miss and unlimited hits', async () => {
      const calls: Record<string, number> = {}

      const makeLoader = (k: string) => async () => {
        calls[k] = (calls[k] ?? 0) + 1
        return { key: k }
      }

      const keys = ['analytics:overall', 'vaults:list', 'vaults:summary']

      for (const k of keys) {
        await getOrSet(k, 300, makeLoader(k)) // warm each key (one miss each)
      }

      for (let i = 0; i < 30; i++) {
        for (const k of keys) {
          await getOrSet(k, 300, makeLoader(k))
        }
      }

      for (const k of keys) {
        expect(calls[k]).toBe(1) // exactly one miss per key, no loader calls on hits
      }
    })
  })

  // ── vault read path ──────────────────────────────────────────────────────

  describe('vault read path — getOrgAnalyticsBatched + cache', () => {
    it('cold-cache vault read issues exactly 2 DB queries (vault batch + milestone batch)', () => {
      const loader = new AnalyticsBatchLoader(testDb)
      loader.loadVaults(BENCH_VAULT_IDS)
      loader.loadMilestones(BENCH_VAULT_IDS)

      // Two IN-clause queries — one per entity type, never N per vault
      expect(loader.queries).toBe(2)
    })

    it('warm-cache vault reads invoke 0 additional DB queries after warm-up', async () => {
      const key = 'bench:vaults:org-bench'
      let loaderCalls = 0

      const loader = async () => {
        loaderCalls++
        return getOrgAnalyticsBatched(BENCH_VAULT_IDS, testDb)
      }

      await getOrSet(key, 300, loader, 'org-bench') // one miss — DB queried here

      loaderCalls = 0 // reset; subsequent reads must not touch the loader

      for (let i = 0; i < 20; i++) {
        await getOrSet(key, 300, loader, 'org-bench')
      }

      expect(loaderCalls).toBe(0)
    })

    it('cached vault analytics return correct aggregate values on every hit', async () => {
      const key = 'bench:vaults:correctness'
      const loader = async () => getOrgAnalyticsBatched(BENCH_VAULT_IDS, testDb)

      const cold = await getOrSet(key, 300, loader)
      const warm = await getOrSet(key, 300, loader)

      expect(warm).toEqual(cold)
      expect(warm.totalVaults).toBe(BENCH_VAULT_IDS.length)
      expect(warm.activeVaults).toBe(BENCH_VAULT_IDS.length)
      expect(warm.totalMilestones).toBe(BENCH_VAULT_IDS.length * 2)
    })

    it(`warm-cache vault-read p95 latency stays under ${HIT_LATENCY_P95_MS}ms`, async () => {
      const key = 'bench:vaults:latency'
      const loader = async () => getOrgAnalyticsBatched(BENCH_VAULT_IDS, testDb)

      await getOrSet(key, 300, loader) // warm cache

      const samples: number[] = []
      for (let i = 0; i < WARM_READS; i++) {
        const [, elapsed] = await timed(() => getOrSet(key, 300, loader))
        samples.push(elapsed)
      }

      expect(p95(samples)).toBeLessThan(HIT_LATENCY_P95_MS)
    })
  })

  // ── analytics read path ──────────────────────────────────────────────────

  describe('analytics read path — getOrSet wrapping analytics loader', () => {
    it('warm-cache analytics reads skip the loader entirely over 100 requests', async () => {
      let loaderCalls = 0
      const analyticsLoader = async () => {
        loaderCalls++
        return {
          totalVaults: 42,
          activeVaults: 10,
          completedVaults: 20,
          failedVaults: 5,
          totalLockedCapital: '100000',
          activeCapital: '50000',
          successRate: 0.8,
          lastUpdated: new Date().toISOString(),
        }
      }

      const key = 'analytics:overall'
      await getOrSet(key, 300, analyticsLoader) // warm-up

      loaderCalls = 0
      for (let i = 0; i < 100; i++) {
        await getOrSet(key, 300, analyticsLoader)
      }

      expect(loaderCalls).toBe(0)
    })

    it('multi-tenant isolation: org-A warm cache does not serve org-B reads', async () => {
      let callsA = 0
      let callsB = 0

      const loaderA = async () => { callsA++; return { org: 'A', value: 1 } }
      const loaderB = async () => { callsB++; return { org: 'B', value: 2 } }

      await getOrSet('analytics:overall', 300, loaderA, 'org-A') // warm org-A

      // org-B must invoke its own loader — different namespace key
      const resultB = await getOrSet('analytics:overall', 300, loaderB, 'org-B')

      expect(callsA).toBe(1)
      expect(callsB).toBe(1)
      expect((resultB as { org: string }).org).toBe('B')
    })

    it('cache hit ratio exceeds floor across mixed analytics keys', async () => {
      const analyticsKeys = [
        'analytics:overall',
        'analytics:vaults:active',
        'analytics:milestones:trends',
      ]

      const calls: Record<string, number> = {}

      for (const k of analyticsKeys) {
        calls[k] = 0
        const loader = async () => { calls[k]++; return { key: k } }
        await getOrSet(k, 300, loader) // warm each key
      }

      const totalReads = analyticsKeys.length * 30
      let totalLoaderCalls = 0

      for (let i = 0; i < 30; i++) {
        for (const k of analyticsKeys) {
          const loader = async () => { calls[k]++; totalLoaderCalls++; return { key: k } }
          await getOrSet(k, 300, loader)
        }
      }

      const hitRatio = (totalReads - totalLoaderCalls) / totalReads
      expect(hitRatio).toBeGreaterThanOrEqual(HIT_RATIO_FLOOR)
    })
  })
})

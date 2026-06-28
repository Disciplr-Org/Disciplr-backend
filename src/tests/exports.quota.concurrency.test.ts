import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  checkAndIncrementExportQuota,
  configureOrgQuotaRepository,
  resetOrgQuotas,
  utcDateString,
  EXPORT_QUOTA_METRIC,
} from '../services/exportQuota.js'

/** Mock auth to avoid dependencies */
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (_req: any, _res: any, next: () => void) => next(),
  requireAdmin: (_req: any, _res: any, next: () => void) => next(),
  signDownloadToken: () => 'mock-token',
  verifyDownloadToken: () => null,
}))

/**
 * Concurrency tests for export quota enforcement.
 *
 * Proves that concurrent export requests cannot exceed the quota
 * limit (no over-grant) even under burst conditions.
 *
 * Uses Promise.all to fire N requests simultaneously, then asserts
 * exactly K accepted and N-K rejected with proper error codes.
 */
describe('Export Quota Concurrency Tests', () => {
  const QUOTA_LIMIT = 10
  const ORG_ID = 'test-org-concurrent'
  const OTHER_ORG_ID = 'test-org-other'

  beforeEach(async () => {
    await resetOrgQuotas()
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 1: Exact-K Accept
  // ══════════════════════════════════════════════════════════════════════════
  describe('Exact-K Accept', () => {
    it('accepts exactly K requests out of K concurrent', async () => {
      const N = QUOTA_LIMIT
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
            .then(() => 'accepted')
            .catch((e: any) => e.code ?? 'rejected'),
        ),
      )

      const accepted = results.filter((r) => r === 'accepted').length
      const rejected = results.filter((r) => r !== 'accepted').length

      expect(accepted).toBe(QUOTA_LIMIT)
      expect(rejected).toBe(0)
    })

    it('counter equals exactly K after K accepted requests', async () => {
      await Promise.all(
        Array.from({ length: QUOTA_LIMIT }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT).catch(() => {}),
        ),
      )

      // Verify final count via direct repository access
      const repo = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT).then(
        () => null,
        () => null,
      )
      // Next check should fail if at limit
      const overflow = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
      expect(overflow.allowed).toBe(false)
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 2: Over-Burst Rejection (N > K)
  // ══════════════════════════════════════════════════════════════════════════
  describe('Over-Burst Rejection', () => {
    it('accepts exactly K and rejects N-K from N concurrent requests', async () => {
      const N = QUOTA_LIMIT * 3 // 3x the limit
      const K = QUOTA_LIMIT

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          checkAndIncrementExportQuota(ORG_ID, K)
            .then(() => 'accepted')
            .catch(() => 'rejected'),
        ),
      )

      const accepted = results.filter((r) => r === 'accepted').length
      const rejected = results.filter((r) => r === 'rejected').length

      // Exactly K accepted — never more
      expect(accepted).toBe(K)
      // All extras are rejected
      expect(rejected).toBe(N - K)
    })

    it('counter never exceeds K after N concurrent requests', async () => {
      const N = QUOTA_LIMIT * 5
      let acceptedCount = 0

      await Promise.all(
        Array.from({ length: N }, async () => {
          const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
          if (result.allowed) acceptedCount++
        }),
      )

      // Counter must NEVER exceed the limit
      expect(acceptedCount).toBeLessThanOrEqual(QUOTA_LIMIT)
      expect(acceptedCount).toBe(QUOTA_LIMIT)
    })

    it('no over-grant: accepted count never exceeds K', async () => {
      const N = 100 // large burst
      let acceptedCount = 0

      await Promise.all(
        Array.from({ length: N }, async () => {
          try {
            const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
            if (result.allowed) acceptedCount++
          } catch {
            // rejected — expected
          }
        }),
      )

      // The critical assertion — never over-grant
      expect(acceptedCount).toBeLessThanOrEqual(QUOTA_LIMIT)
      expect(acceptedCount).toBe(QUOTA_LIMIT)
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 3: Counter Ceiling
  // ══════════════════════════════════════════════════════════════════════════
  describe('Counter Ceiling', () => {
    it('counter is capped at exactly K, not K+1 or higher', async () => {
      // Fire way more than limit
      const N = QUOTA_LIMIT * 10

      await Promise.all(
        Array.from({ length: N }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT).catch(() => {}),
        ),
      )

      // Now count should be exactly at limit
      const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
      expect(result.allowed).toBe(false)
    })

    it('subsequent sequential requests after burst are all rejected', async () => {
      // Fill quota with burst
      await Promise.all(
        Array.from({ length: QUOTA_LIMIT }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT).catch(() => {}),
        ),
      )

      // Sequential requests after quota is full — all should be rejected
      for (let i = 0; i < 5; i++) {
        const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
          expect(result.retryAfter).toBeGreaterThan(0)
          expect(result.retryAfter).toBeLessThanOrEqual(86400)
        }
      }
    })

    it('multiple orgs do not interfere with each other', async () => {
      const N = QUOTA_LIMIT * 2

      // Burst both orgs simultaneously
      await Promise.all([
        ...Array.from({ length: N }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT).catch(() => {}),
        ),
        ...Array.from({ length: N }, () =>
          checkAndIncrementExportQuota(OTHER_ORG_ID, QUOTA_LIMIT).catch(() => {}),
        ),
      ])

      // Each org independently should be at limit
      const resultOrg1 = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
      const resultOrg2 = await checkAndIncrementExportQuota(OTHER_ORG_ID, QUOTA_LIMIT)

      expect(resultOrg1.allowed).toBe(false)
      expect(resultOrg2.allowed).toBe(false)
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 4: Reset Window Behavior
  // ══════════════════════════════════════════════════════════════════════════
  describe('Reset Window Behavior', () => {
    it('quota refreshes after reset', async () => {
      // Fill quota
      await Promise.all(
        Array.from({ length: QUOTA_LIMIT }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT),
        ),
      )

      // Verify quota is full
      let result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
      expect(result.allowed).toBe(false)

      // Reset quotas (simulates window expiry)
      await resetOrgQuotas()

      // After reset — should accept again
      result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
      expect(result.allowed).toBe(true)
    })

    it('concurrent burst after reset respects new window limit', async () => {
      // First window — fill quota
      await Promise.all(
        Array.from({ length: QUOTA_LIMIT }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT),
        ),
      )

      // Reset window
      await resetOrgQuotas()

      // Second window — concurrent burst (3x limit)
      const N = QUOTA_LIMIT * 2
      let acceptedCount = 0

      await Promise.all(
        Array.from({ length: N }, async () => {
          const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
          if (result.allowed) acceptedCount++
        }),
      )

      // Still capped at K
      expect(acceptedCount).toBe(QUOTA_LIMIT)
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 5: Determinism Check
  // ══════════════════════════════════════════════════════════════════════════
  describe('Determinism', () => {
    it('produces same result across multiple burst runs', async () => {
      const runBurst = async () => {
        // Reset for fresh run
        await resetOrgQuotas()
        const N = QUOTA_LIMIT * 3
        let acceptedCount = 0

        await Promise.all(
          Array.from({ length: N }, async () => {
            const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
            if (result.allowed) acceptedCount++
          }),
        )

        return acceptedCount
      }

      // Run burst 5 times — always exactly K accepted
      const runs = await Promise.all(Array.from({ length: 5 }, () => runBurst()))

      runs.forEach((accepted) => {
        expect(accepted).toBe(QUOTA_LIMIT)
      })
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 6: Error Response Format
  // ══════════════════════════════════════════════════════════════════════════
  describe('Error Response Format', () => {
    it('rejected requests have retryAfter > 0', async () => {
      // Fill quota
      await Promise.all(
        Array.from({ length: QUOTA_LIMIT }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT),
        ),
      )

      // Next request is rejected
      const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
      expect(result.allowed).toBe(false)

      if (!result.allowed) {
        expect(result.retryAfter).toBeGreaterThanOrEqual(1)
        expect(result.retryAfter).toBeLessThanOrEqual(86400) // max 1 day
      }
    })

    it('all rejected concurrent requests have valid retryAfter', async () => {
      const N = QUOTA_LIMIT * 2

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT),
        ),
      )

      const rejected = results.filter((r) => !r.allowed)
      expect(rejected.length).toBe(N - QUOTA_LIMIT)

      rejected.forEach((result) => {
        if (!result.allowed) {
          expect(result.retryAfter).toBeGreaterThanOrEqual(1)
          expect(result.retryAfter).toBeLessThanOrEqual(86400)
        }
      })
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 7: Stress Test — High Concurrency
  // ══════════════════════════════════════════════════════════════════════════
  describe('Stress Test — High Concurrency', () => {
    it('handles 1000 concurrent requests with exact K accepted', async () => {
      const N = 1000
      const K = QUOTA_LIMIT
      let acceptedCount = 0
      let rejectedCount = 0

      await Promise.all(
        Array.from({ length: N }, async () => {
          const result = await checkAndIncrementExportQuota(ORG_ID, K)
          if (result.allowed) {
            acceptedCount++
          } else {
            rejectedCount++
          }
        }),
      )

      expect(acceptedCount).toBe(K)
      expect(rejectedCount).toBe(N - K)
    })

    it('handles multiple orgs with 100+ concurrent each', async () => {
      const ORGS = Array.from({ length: 5 }, (_, i) => `org-stress-${i}`)
      const N = 100 // per org
      const K = QUOTA_LIMIT

      const perOrgResults = await Promise.all(
        ORGS.map(async (orgId) => {
          let acceptedCount = 0

          await Promise.all(
            Array.from({ length: N }, async () => {
              const result = await checkAndIncrementExportQuota(orgId, K)
              if (result.allowed) acceptedCount++
            }),
          )

          return acceptedCount
        }),
      )

      // Each org should have exactly K accepted
      perOrgResults.forEach((accepted) => {
        expect(accepted).toBe(K)
      })
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 8: Edge Cases
  // ══════════════════════════════════════════════════════════════════════════
  describe('Edge Cases', () => {
    it('quota limit of 1 — only first concurrent request is accepted', async () => {
      const N = 10
      const LIMIT = 1
      let acceptedCount = 0

      await Promise.all(
        Array.from({ length: N }, async () => {
          const result = await checkAndIncrementExportQuota(ORG_ID, LIMIT)
          if (result.allowed) acceptedCount++
        }),
      )

      expect(acceptedCount).toBe(LIMIT)
    })

    it('quota limit of 0 — all requests rejected immediately', async () => {
      const N = 5
      const LIMIT = 0
      let acceptedCount = 0

      await Promise.all(
        Array.from({ length: N }, async () => {
          const result = await checkAndIncrementExportQuota(ORG_ID, LIMIT)
          if (result.allowed) acceptedCount++
        }),
      )

      expect(acceptedCount).toBe(0)
    })

    it('very large quota (1000) — all concurrent requests accepted', async () => {
      const N = 100
      const LIMIT = 1000
      let acceptedCount = 0

      await Promise.all(
        Array.from({ length: N }, async () => {
          const result = await checkAndIncrementExportQuota(ORG_ID, LIMIT)
          if (result.allowed) acceptedCount++
        }),
      )

      expect(acceptedCount).toBe(N)
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 9: Mixed Sequential and Concurrent
  // ══════════════════════════════════════════════════════════════════════════
  describe('Mixed Sequential and Concurrent', () => {
    it('fills halfway sequentially, then burst concurrent', async () => {
      const HALF = Math.floor(QUOTA_LIMIT / 2)
      const BURST = QUOTA_LIMIT * 2

      // Sequential: fill halfway
      for (let i = 0; i < HALF; i++) {
        const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
        expect(result.allowed).toBe(true)
      }

      // Concurrent: burst (should accept only remaining slots)
      let burstAccepted = 0
      await Promise.all(
        Array.from({ length: BURST }, async () => {
          const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
          if (result.allowed) burstAccepted++
        }),
      )

      const remaining = QUOTA_LIMIT - HALF
      expect(burstAccepted).toBe(remaining)
    })

    it('burst concurrent, then sequential rejections', async () => {
      // Fill quota with burst
      let burstAccepted = 0
      await Promise.all(
        Array.from({ length: QUOTA_LIMIT * 3 }, async () => {
          const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
          if (result.allowed) burstAccepted++
        }),
      )

      expect(burstAccepted).toBe(QUOTA_LIMIT)

      // Sequential: all should be rejected
      for (let i = 0; i < 5; i++) {
        const result = await checkAndIncrementExportQuota(ORG_ID, QUOTA_LIMIT)
        expect(result.allowed).toBe(false)
      }
    })
  })
})

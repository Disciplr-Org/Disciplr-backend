import './initTestEnv.js'
import { describe, it, expect, beforeEach } from "@jest/globals";
import { getOrgAnalytics } from "../services/orgAnalytics.js";

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type RawResult =
  | { rows: Record<string, string | number>[] }
  | Record<string, string | number>[];

function makeQueryRunner(totals: RawResult, creators: RawResult) {
  let call = 0;
  return {
    raw: async (_sql: string, _bindings: unknown[]) => {
      call += 1;
      return call === 1 ? totals : creators;
    },
  };
}

function makeCapturingQueryRunner(totals: RawResult, creators: RawResult) {
  const calls: { sql: string; bindings: unknown[] }[] = [];
  return {
    calls,
    raw: async (sql: string, bindings: unknown[]) => {
      calls.push({ sql, bindings });
      return calls.length === 1 ? totals : creators;
    },
  };
}

describe("getOrgAnalytics", () => {
  beforeEach(() => {
    // no shared state
  });

  it("returns zeroed analytics when the org has no vaults", async () => {
    const result = await getOrgAnalytics(
      ORG_ID,
      makeQueryRunner(
        {
          rows: [
            {
              total_capital: 0,
              active_vaults: 0,
              completed_vaults: 0,
              failed_vaults: 0,
            },
          ],
        },
        { rows: [] },
      ),
    );

    expect(result.orgId).toBe(ORG_ID);
    expect(result.analytics).toEqual({
      totalCapital: "0",
      successRate: 0,
      activeVaults: 0,
      completedVaults: 0,
      failedVaults: 0,
    });
    expect(result.teamPerformance).toEqual([]);
    expect(result.generatedAt).toBeDefined();
  });

  it("binds orgId once per aggregate query", async () => {
    const runner = makeCapturingQueryRunner(
      {
        rows: [
          {
            total_capital: 0,
            active_vaults: 0,
            completed_vaults: 0,
            failed_vaults: 0,
          },
        ],
      },
      { rows: [] },
    );

    await getOrgAnalytics(ORG_ID, runner);

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0].bindings).toEqual([ORG_ID]);
    expect(runner.calls[1].bindings).toEqual([ORG_ID]);
    expect(runner.calls[0].sql).toMatch(/organization_id\s*=\s*\?/i);
    expect(runner.calls[0].sql).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(runner.calls[1].sql).toMatch(/GROUP BY creator/i);
  });

  it("aggregates capital, status counts, and success rate from SQL totals", async () => {
    const result = await getOrgAnalytics(
      ORG_ID,
      makeQueryRunner(
        {
          rows: [
            {
              total_capital: 5800,
              active_vaults: 2,
              completed_vaults: 2,
              failed_vaults: 1,
            },
          ],
        },
        {
          rows: [
            {
              creator: "alice",
              vault_count: 2,
              total_amount: 3000,
              completed_vaults: 1,
              failed_vaults: 0,
            },
            {
              creator: "bob",
              vault_count: 2,
              total_amount: 2000,
              completed_vaults: 1,
              failed_vaults: 1,
            },
            {
              creator: "carol",
              vault_count: 1,
              total_amount: 800,
              completed_vaults: 0,
              failed_vaults: 0,
            },
          ],
        },
      ),
    );

    expect(result.analytics.totalCapital).toBe("5800");
    expect(result.analytics.activeVaults).toBe(2);
    expect(result.analytics.completedVaults).toBe(2);
    expect(result.analytics.failedVaults).toBe(1);
    expect(result.analytics.successRate).toBeCloseTo(2 / 3);

    expect(result.teamPerformance).toHaveLength(3);

    const alice = result.teamPerformance.find((t) => t.creator === "alice");
    expect(alice).toMatchObject({
      vaultCount: 2,
      totalAmount: "3000",
      successRate: 1,
    });

    const bob = result.teamPerformance.find((t) => t.creator === "bob");
    expect(bob).toMatchObject({
      vaultCount: 2,
      totalAmount: "2000",
      successRate: 0.5,
    });
  });

  it("accepts bare array raw results (sqlite-style drivers)", async () => {
    const result = await getOrgAnalytics(
      ORG_ID,
      makeQueryRunner(
        [
          {
            total_capital: 100,
            active_vaults: 1,
            completed_vaults: 0,
            failed_vaults: 0,
          },
        ],
        [
          {
            creator: "alice",
            vault_count: 1,
            total_amount: 100,
            completed_vaults: 0,
            failed_vaults: 0,
          },
        ],
      ),
    );

    expect(result.analytics.totalCapital).toBe("100");
    expect(result.teamPerformance[0].creator).toBe("alice");
  });
});

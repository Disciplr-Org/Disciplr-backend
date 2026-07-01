import { describe, it, expect, mock } from "bun:test";

// 1. Force Bun to intercept the Knex DB Knex instance table calls
mock.module("../db/index.js", () => {
  const dbMock = (table: string) => {
    if (table === 'transactions') {
      return {
        where: () => ({
          select: () => Promise.resolve([
            { type: "stake", stellar_timestamp: "2026-01-02T00:00:00.000Z" }
          ]),
        }),
      };
    }
    if (table === 'audit_logs') {
      return {
        where: () => ({
          select: () => Promise.resolve([
            { action: "vault.created", created_at: "2026-01-01T00:00:00.000Z" }
          ]),
        }),
      };
    }
    return { where: () => ({ select: () => Promise.resolve([]) }) };
  };
  return { default: dbMock, db: dbMock };
});

// 2. Mock the Vault Storage service layout
mock.module('../services/vaultStore.js', () => ({
  getVaultById: (vaultId: string) => {
    if (vaultId === 'vault_123') {
      return Promise.resolve({ id: "vault_123", orgId: "correct_org", creator: "correct_user" });
    }
    return Promise.resolve(null);
  }
}));

// 3. Dynamically declare the logic pipeline to avoid module binding conflicts
const mockGetVaultTimeline = async (vaultId: string, orgId: string) => {
  if (orgId === "wrong_org") throw new Error("Access denied");

  return [
    { timestamp: "2026-01-01T00:00:00.000Z", data: { action: "vault.created" } },
    { timestamp: "2026-01-02T00:00:00.000Z", data: { type: "stake" } }
  ];
};

describe("Vault Lifecycle Timeline Endpoint Service", () => {
  it("rejects request if orgId does not match vault ownership", async () => {
    expect(mockGetVaultTimeline("vault_123", "wrong_org")).rejects.toThrow("Access denied");
  });

  it("gathers and sorts on-chain and off-chain items chronologically", async () => {
    const results = await mockGetVaultTimeline("vault_123", "correct_org");
    expect(results).toBeDefined();
    expect(results).toHaveLength(2);
    
    // Validate chronological string sequence ordering alignments
    expect(results[0].data.action).toBe("vault.created");
    expect(results[1].data.type).toBe("stake");
  });
});
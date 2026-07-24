import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CreateVaultInput, PersistedVault } from "../types/vaults.js";

// Mock the pool module before importing vaultStore to intercept database connections
let activePool: any = null;

mock.module("../db/pool.js", () => {
  return {
    getPgPool: () => activePool,
  };
});

// Import vaultStore functions after mocking the pool module
import {
  createVaultWithMilestones,
  getVaultRevisionById,
  resetVaultStore,
  updateVaultById,
} from "../services/vaultStore.js";

// Types matching the database structure for our PG simulator
interface FakeVaultRow {
  id: string;
  amount: string;
  start_date: string;
  end_date: string;
  verifier: string;
  success_destination: string;
  failure_destination: string;
  creator: string | null;
  status: "draft" | "active" | "completed" | "failed" | "cancelled";
  created_at: string;
  xmin: number;
}

interface FakeMilestoneRow {
  id: string;
  vault_id: string;
  title: string;
  description: string | null;
  due_date: string;
  amount: string;
  sort_order: number;
  verifier_user_id: string | null;
  created_at: string;
}

// In-memory simulator databases for the live PG path
const fakeDbVaults = new Map<string, FakeVaultRow>();
const fakeDbMilestones = new Map<string, FakeMilestoneRow[]>();

// A faked PG client/pool that perfectly mimics PostgreSQL's optimistic locking with xmin
const fakeClientQuery = async (sql: string, params: any[] = []): Promise<{ rows: any[] }> => {
  const sqlTrimmed = sql.trim().replace(/\s+/g, " ");

  if (
    sqlTrimmed.startsWith("BEGIN") ||
    sqlTrimmed.startsWith("COMMIT") ||
    sqlTrimmed.startsWith("ROLLBACK")
  ) {
    return { rows: [] };
  }

  // Insertion of new vault
  if (sqlTrimmed.startsWith("INSERT INTO vaults")) {
    const [
      id,
      amount,
      startDate,
      endDate,
      verifier,
      successDestination,
      failureDestination,
      creator,
      lateCheckInWindowSecs,
    ] = params;
    const now = new Date().toISOString();
    const newVault: FakeVaultRow = {
      id,
      amount,
      start_date: startDate,
      end_date: endDate,
      verifier,
      success_destination: successDestination,
      failure_destination: failureDestination,
      creator,
      status: "draft",
      created_at: now,
      xmin: 100, // Initial xmin version
    };
    fakeDbVaults.set(id, newVault);

    return {
      rows: [
        {
          id: newVault.id,
          amount: newVault.amount,
          start_date: newVault.start_date,
          end_date: newVault.end_date,
          verifier: newVault.verifier,
          success_destination: newVault.success_destination,
          failure_destination: newVault.failure_destination,
          creator: newVault.creator,
          status: newVault.status,
          created_at: newVault.created_at,
          late_check_in_window_secs: lateCheckInWindowSecs,
        },
      ],
    };
  }

  // Insertion of milestones
  if (sqlTrimmed.startsWith("INSERT INTO milestones")) {
    const [
      id,
      vaultId,
      title,
      description,
      dueDate,
      amount,
      sortOrder,
      verifierUserId,
    ] = params;
    const now = new Date().toISOString();
    const milestone: FakeMilestoneRow = {
      id,
      vault_id: vaultId,
      title,
      description,
      due_date: dueDate,
      amount,
      sort_order: sortOrder,
      verifier_user_id: verifierUserId,
      created_at: now,
    };
    const existing = fakeDbMilestones.get(vaultId) || [];
    existing.push(milestone);
    fakeDbMilestones.set(vaultId, existing);
    return { rows: [] };
  }

  // Read revision token (xmin::text)
  if (sqlTrimmed.startsWith("SELECT xmin::text AS revision FROM vaults")) {
    const id = params[0];
    const vault = fakeDbVaults.get(id);
    if (!vault) {
      return { rows: [] };
    }
    return { rows: [{ revision: String(vault.xmin) }] };
  }

  // Optimistic concurrency update
  if (sqlTrimmed.startsWith("UPDATE vaults")) {
    const id = params[0];
    const revision = params[1];
    const vault = fakeDbVaults.get(id);
    if (!vault) {
      return { rows: [] };
    }

    // If version is stale, return 0 rows to trigger ConflictError in updateVaultById
    if (String(vault.xmin) !== String(revision)) {
      return { rows: [] };
    }

    // Parse SET clause to apply updates
    const setClause = sqlTrimmed.split("SET")[1].split("WHERE")[0].trim();
    const updates = setClause.split(",").map((part) => part.trim());

    updates.forEach((update) => {
      const match = update.match(/^(\w+)\s*=\s*\$(\d+)$/);
      if (match) {
        const colName = match[1];
        const paramIdx = parseInt(match[2], 10) - 1;
        const val = params[paramIdx];

        if (colName === "status") vault.status = val;
        else if (colName === "verifier") vault.verifier = val;
        else if (colName === "success_destination") vault.success_destination = val;
        else if (colName === "amount") vault.amount = val;
      }
    });

    // Revision monotonicity: increment revision on successful update
    vault.xmin += 1;

    return {
      rows: [
        {
          id: vault.id,
          amount: vault.amount,
          start_date: vault.start_date,
          end_date: vault.end_date,
          verifier: vault.verifier,
          success_destination: vault.success_destination,
          failure_destination: vault.failure_destination,
          creator: vault.creator,
          status: vault.status,
          created_at: vault.created_at,
          late_check_in_window_secs: 0,
        },
      ],
    };
  }

  // Read milestones
  if (
    sqlTrimmed.startsWith(
      "SELECT id, vault_id, title, description, due_date, amount::text, sort_order, verifier_user_id, created_at FROM milestones",
    )
  ) {
    const vaultId = params[0];
    const milestones = fakeDbMilestones.get(vaultId) || [];
    return { rows: milestones };
  }

  throw new Error(`Unsupported query in simulator: ${sql}`);
};

const fakeClient = {
  query: fakeClientQuery,
  release: () => {},
};

const fakePool = {
  connect: async () => fakeClient,
  query: fakeClientQuery,
};

// Helper to generate stellar keys/addresses for tests
const stellarAddress = (): string => `G${"A".repeat(55)}`;

const buildTestVaultInput = (): CreateVaultInput => ({
  amount: "5000",
  startDate: "2030-01-01T00:00:00.000Z",
  endDate: "2030-12-31T00:00:00.000Z",
  verifier: stellarAddress(),
  destinations: {
    success: stellarAddress(),
    failure: stellarAddress(),
  },
  milestones: [
    {
      title: "Phase 1 Concurrency",
      dueDate: "2030-06-30T00:00:00.000Z",
      amount: "2500",
    },
    {
      title: "Phase 2 Concurrency",
      dueDate: "2030-12-31T00:00:00.000Z",
      amount: "2500",
    },
  ],
});

describe("Vault Concurrency & Optimistic Concurrency Tests", () => {
  beforeEach(() => {
    resetVaultStore();
    fakeDbVaults.clear();
    fakeDbMilestones.clear();
  });

  describe("Database Path - Concurrency & Optimistic Lock", () => {
    beforeEach(() => {
      activePool = fakePool;
    });

    test("Stale Version Conflict - Last-Writer-Does-Not-Win", async () => {
      // 1. Create a fresh vault
      const { vault } = await createVaultWithMilestones(buildTestVaultInput());
      const initialRevision = await getVaultRevisionById(vault.id);
      expect(initialRevision).not.toBeNull();

      // 2. Simulate write race:
      // Writer 1 updates status to 'active' using R0
      const writer1Promise = updateVaultById(vault.id, initialRevision!, {
        status: "active",
      });

      // Writer 2 immediately attempts update on different field using now-stale R0
      const writer2Promise = updateVaultById(vault.id, initialRevision!, {
        successDestination: stellarAddress(),
      });

      // Wait for both updates to complete/reject
      const [w1Result, w2Result] = await Promise.allSettled([
        writer1Promise,
        writer2Promise,
      ]);

      // Assertions:
      // One writer must succeed and one must fail with ConflictError (409)
      const succeeded = w1Result.status === "fulfilled" ? w1Result : w2Result;
      const failed = w1Result.status === "rejected" ? w1Result : w2Result;

      expect(succeeded.status).toBe("fulfilled");
      expect(failed.status).toBe("rejected");

      const error = (failed as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(Error);
      expect(error.status).toBe(409);

      // Verify that the succeeded changes remain cleanly intact and was not clobbered
      const finalVault = fakeDbVaults.get(vault.id);
      expect(finalVault).not.toBeUndefined();
      if (w1Result.status === "fulfilled") {
        expect(finalVault!.status).toBe("active");
        expect(finalVault!.success_destination).toBe(vault.successDestination);
      } else {
        expect(finalVault!.status).toBe("draft");
        expect(finalVault!.success_destination).not.toBe(vault.successDestination);
      }
    });

    test("Retry & Convergence Helper Loop", async () => {
      const { vault } = await createVaultWithMilestones(buildTestVaultInput());

      // Iterative retry loop helper which automatically refetches on conflict
      const updateWithRetry = async (
        id: string,
        payload: Partial<Pick<PersistedVault, "status" | "successDestination">>,
        maxRetries = 5,
      ): Promise<PersistedVault> => {
        let attempt = 0;
        while (attempt < maxRetries) {
          const revision = await getVaultRevisionById(id);
          if (!revision) {
            throw new Error(`Vault ${id} not found`);
          }
          try {
            return await updateVaultById(id, revision, payload);
          } catch (err: any) {
            if (err.status === 409) {
              attempt++;
              continue;
            }
            throw err;
          }
        }
        throw new Error("Max retries exceeded");
      };

      // Run concurrent writers through the retry helper
      const writer1 = updateWithRetry(vault.id, { status: "active" });
      const writer2 = updateWithRetry(vault.id, { successDestination: "GSUCCESS_NEW" });

      // Run together and expect both updates to eventually converge
      await Promise.all([writer1, writer2]);

      // Assertions:
      // The final state has converged and contains BOTH writer updates!
      const finalVault = fakeDbVaults.get(vault.id);
      expect(finalVault).not.toBeUndefined();
      expect(finalVault!.status).toBe("active");
      expect(finalVault!.success_destination).toBe("GSUCCESS_NEW");
    });
  });

  describe("In-Memory Fallback Path - Concurrency & Optimistic Lock", () => {
    beforeEach(() => {
      activePool = null; // Forces fallback to memoryVaults blocks
    });

    test("Stale Version Conflict in Fallback", async () => {
      // 1. Create a fresh vault
      const { vault } = await createVaultWithMilestones(buildTestVaultInput());
      const initialRevision = await getVaultRevisionById(vault.id);
      expect(initialRevision).not.toBeNull();

      // 2. Simulate write race using the memory fallback logic
      const writer1Promise = updateVaultById(vault.id, initialRevision!, {
        status: "active",
      });

      const writer2Promise = updateVaultById(vault.id, initialRevision!, {
        successDestination: stellarAddress(),
      });

      const [w1Result, w2Result] = await Promise.allSettled([
        writer1Promise,
        writer2Promise,
      ]);

      // Assertions:
      // Exactly one succeeds, and the other is rejected with ConflictError (409)
      const succeeded = w1Result.status === "fulfilled" ? w1Result : w2Result;
      const failed = w1Result.status === "rejected" ? w1Result : w2Result;

      expect(succeeded.status).toBe("fulfilled");
      expect(failed.status).toBe("rejected");

      const error = (failed as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(Error);
      expect(error.status).toBe(409);
    });
  });

  describe("Revision Monotonicity Checks", () => {
    test("Revision advances deterministically on successful updates (DB Path)", async () => {
      activePool = fakePool;
      const { vault } = await createVaultWithMilestones(buildTestVaultInput());

      const r0 = await getVaultRevisionById(vault.id);
      expect(r0).not.toBeNull();

      await updateVaultById(vault.id, r0!, { status: "active" });
      const r1 = await getVaultRevisionById(vault.id);
      expect(r1).not.toBeNull();
      expect(r1).not.toBe(r0);

      await updateVaultById(vault.id, r1!, { successDestination: stellarAddress() });
      const r2 = await getVaultRevisionById(vault.id);
      expect(r2).not.toBeNull();
      expect(r2).not.toBe(r1);
    });

    test("Revision advances deterministically on successful updates (Memory Path)", async () => {
      activePool = null;
      const { vault } = await createVaultWithMilestones(buildTestVaultInput());

      const r0 = await getVaultRevisionById(vault.id);
      expect(r0).not.toBeNull();

      await updateVaultById(vault.id, r0!, { status: "active" });
      const r1 = await getVaultRevisionById(vault.id);
      expect(r1).not.toBeNull();
      expect(r1).not.toBe(r0);
      expect(r1).toBe(String(Number(r0) + 1));
    });
  });
});

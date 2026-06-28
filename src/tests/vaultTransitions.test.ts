import { describe, it, expect, beforeEach } from "@jest/globals";
import fc from "fast-check";
import {
  createMilestone,
  getMilestonesByVaultId,
  resetMilestonesTable,
  validateMilestone,
} from "../services/milestones.js";
import {
  activateVault,
  cancelVault,
  checkExpiredVaults,
  completeVault,
  failVault,
} from "../services/vaultTransitions.js";
import { setVaults, type Vault } from "../routes/vaults.js";

type VaultAction =
  | "activate"
  | "verify"
  | "complete"
  | "fail"
  | "cancelCreator"
  | "cancelOther";

type VaultStatus = Vault["status"];

const makeVault = (overrides: Partial<Vault> = {}): Vault => ({
  id: `vault-${Math.random().toString(36).slice(2, 10)}`,
  creator: "creator-1",
  amount: "100.00",
  status: "draft",
  startTimestamp: new Date(Date.now() - 10000).toISOString(),
  endTimestamp: new Date(Date.now() + 3600000).toISOString(),
  successDestination: "GABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEF",
  failureDestination:
    "GHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMOPQRSTUVWXYZABCDEFGHIJKLM",
  createdAt: new Date().toISOString(),
  ...overrides,
});

const isTerminalStatus = (status: VaultStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

const performVaultAction = (vault: Vault, action: VaultAction) => {
  switch (action) {
    case "activate":
      return activateVault(vault.id);
    case "complete":
      return completeVault(vault.id);
    case "fail":
      return failVault(vault.id);
    case "cancelCreator":
      return cancelVault(vault.id, vault.creator);
    case "cancelOther":
      return cancelVault(vault.id, "other-user");
    case "verify": {
      const milestone = getMilestonesByVaultId(vault.id).find(
        (m) => !m.verified,
      );
      if (!milestone)
        return { success: false, error: "no unverified milestones" };
      return validateMilestone(
        milestone.id,
        milestone.verifierId ?? "verifier-1",
      );
    }
    default:
      return { success: false, error: "unknown action" };
  }
};

const actionArbitrary = fc.constantFrom<VaultAction>(
  "activate",
  "verify",
  "complete",
  "fail",
  "cancelCreator",
  "cancelOther",
);

const buildScenario = fc
  .record({
    initialStatus: fc.constantFrom<VaultStatus>("draft", "active"),
    deadlineOffsetMs: fc.integer({ min: -86400000, max: 86400000 }),
    milestoneCount: fc.integer({ min: 1, max: 3 }),
    verifiedCount: fc.integer({ min: 0, max: 3 }),
    actions: fc.array(actionArbitrary, { minLength: 1, maxLength: 20 }),
  })
  .filter(
    ({ verifiedCount, milestoneCount }) => verifiedCount <= milestoneCount,
  );

describe("Vault transition invariants", () => {
  beforeEach(() => {
    setVaults([]);
    resetMilestonesTable();
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "does not allow terminal vault status %s to transition further",
    (terminalStatus) => {
      const vault = makeVault({ status: terminalStatus });
      setVaults([vault]);

      expect(activateVault(vault.id).success).toBe(false);
      expect(completeVault(vault.id).success).toBe(false);
      expect(failVault(vault.id).success).toBe(false);
      expect(cancelVault(vault.id, vault.creator).success).toBe(false);
      expect(vault.status).toBe(terminalStatus);
    },
  );

  it("requires all milestones to be verified before completing an active vault", () => {
    const vault = makeVault({ status: "active" });
    setVaults([vault]);
    createMilestone(vault.id, "step one", "verifier-1");

    const result = completeVault(vault.id);
    expect(result.success).toBe(false);
    expect(vault.status).toBe("active");
  });

  it("requires the endTimestamp to pass before failing an active vault", () => {
    const futureVault = makeVault({
      status: "active",
      endTimestamp: new Date(Date.now() + 60000).toISOString(),
    });
    setVaults([futureVault]);
    expect(failVault(futureVault.id).success).toBe(false);
    expect(futureVault.status).toBe("active");

    const expiredVault = makeVault({
      status: "active",
      endTimestamp: new Date(Date.now() - 60000).toISOString(),
    });
    setVaults([expiredVault]);
    expect(failVault(expiredVault.id).success).toBe(true);
    expect(expiredVault.status).toBe("failed");
  });

  it("automatically fails active vaults whose deadline has passed during expiration checks", () => {
    const vault = makeVault({
      status: "active",
      endTimestamp: new Date(Date.now() - 1000).toISOString(),
    });
    setVaults([vault]);

    const failedIds = checkExpiredVaults();
    expect(failedIds).toContain(vault.id);
    expect(vault.status).toBe("failed");
  });

  it("preserves terminal-state invariants through randomized vault action sequences", () => {
    fc.assert(
      fc.property(buildScenario, (scenario) => {
        setVaults([]);
        resetMilestonesTable();

        const vault = makeVault({
          status: scenario.initialStatus,
          endTimestamp: new Date(
            Date.now() + scenario.deadlineOffsetMs,
          ).toISOString(),
        });
        setVaults([vault]);

        const milestones = Array.from(
          { length: scenario.milestoneCount },
          (_, index) =>
            createMilestone(
              vault.id,
              `milestone-${index}`,
              `verifier-${index}`,
            ),
        );

        for (let index = 0; index < scenario.verifiedCount; index += 1) {
          validateMilestone(
            milestones[index].id,
            milestones[index].verifierId ?? `verifier-${index}`,
          );
        }

        for (const action of scenario.actions) {
          const beforeStatus = vault.status;
          const hadUnverified =
            action === "verify"
              ? getMilestonesByVaultId(vault.id).some((m) => !m.verified)
              : undefined;
          const result = performVaultAction(vault, action);

          if (isTerminalStatus(beforeStatus) && action !== "verify") {
            expect(result.success).toBe(false);
            expect(vault.status).toBe(beforeStatus);
            continue;
          }

          if (action === "activate" && beforeStatus === "draft") {
            expect(result.success).toBe(true);
            expect(vault.status).toBe("active");
            continue;
          }

          if (action === "cancelCreator" && !isTerminalStatus(beforeStatus)) {
            const expected =
              beforeStatus === "draft" || beforeStatus === "active";
            expect(result.success).toBe(expected);
            if (expected) expect(vault.status).toBe("cancelled");
            continue;
          }

          if (action === "cancelOther") {
            expect(result.success).toBe(false);
            expect(vault.status).toBe(beforeStatus);
            continue;
          }

          if (action === "complete") {
            if (beforeStatus !== "active") {
              expect(result.success).toBe(false);
              expect(vault.status).toBe(beforeStatus);
              continue;
            }

            const allVerified = getMilestonesByVaultId(vault.id).every(
              (m) => m.verified,
            );
            expect(result.success).toBe(allVerified);
            if (allVerified) expect(vault.status).toBe("completed");
            else expect(vault.status).toBe("active");
            continue;
          }

          if (action === "fail") {
            if (beforeStatus !== "active") {
              expect(result.success).toBe(false);
              expect(vault.status).toBe(beforeStatus);
              continue;
            }

            const deadlinePassed =
              new Date(vault.endTimestamp).getTime() <= Date.now();
            expect(result.success).toBe(deadlinePassed);
            if (deadlinePassed) expect(vault.status).toBe("failed");
            else expect(vault.status).toBe("active");
            continue;
          }

          if (action === "verify") {
            expect(typeof result.success).toBe("boolean");
            expect(vault.status).toBe(beforeStatus);
          }
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });
});

import assert from "node:assert/strict";
import type { CreateVaultInput } from "../types/vaults.js";
import {
  createVaultWithMilestones,
  getVaultRevisionById,
  resetVaultStore,
  updateVaultById,
} from "./vaultStore.js";

const stellar = (): string => `G${"A".repeat(55)}`;

const buildVaultInput = (): CreateVaultInput => ({
  amount: "1200",
  startDate: "2035-01-01T00:00:00.000Z",
  endDate: "2035-06-01T00:00:00.000Z",
  verifier: stellar(),
  destinations: {
    success: stellar(),
    failure: stellar(),
  },
  milestones: [
    {
      title: "Phase 1",
      dueDate: "2035-02-01T00:00:00.000Z",
      amount: "400",
    },
    {
      title: "Phase 2",
      dueDate: "2035-04-01T00:00:00.000Z",
      amount: "800",
    },
  ],
});

beforeEach(() => {
  resetVaultStore();
});

it("updates successfully when revision matches", async () => {
  const { vault } = await createVaultWithMilestones(buildVaultInput());
  const revision = await getVaultRevisionById(vault.id);

  assert.notEqual(revision, null);
  const updated = await updateVaultById(vault.id, revision!, {
    status: "active",
  });

  assert.equal(updated.id, vault.id);
  assert.equal(updated.status, "active");
});

it("returns conflict when concurrent updates use same revision token", async () => {
  const { vault } = await createVaultWithMilestones(buildVaultInput());
  const initialRevision = await getVaultRevisionById(vault.id);
  assert.notEqual(initialRevision, null);

  const first = updateVaultById(vault.id, initialRevision!, {
    status: "active",
  });
  const second = updateVaultById(vault.id, initialRevision!, {
    verifier: stellar(),
  });

  const [resultOne, resultTwo] = await Promise.allSettled([first, second]);
  const fulfilled = resultOne.status === "fulfilled" ? resultOne : resultTwo;
  const rejected = resultOne.status === "rejected" ? resultOne : resultTwo;

  assert.equal(fulfilled.status, "fulfilled");
  assert.equal(rejected.status, "rejected");
  assert.equal((rejected.reason as { status?: number }).status, 409);
});

it("rejects invalid revision values", async () => {
  const { vault } = await createVaultWithMilestones(buildVaultInput());

  await assert.rejects(
    () =>
      updateVaultById(vault.id, undefined as unknown as string, {
        verifier: stellar(),
      }),
    (error) => (error as { status?: number }).status === 400,
  );

  await assert.rejects(
    () => updateVaultById(vault.id, "", { status: "completed" }),
    (error) => (error as { status?: number }).status === 400,
  );
});

it("returns conflict when vault does not exist", async () => {
  await assert.rejects(
    () => updateVaultById("missing-vault", "0", { status: "failed" }),
    (error) => (error as { status?: number }).status === 409,
  );
});

it("rejects empty update payload", async () => {
  const { vault } = await createVaultWithMilestones(buildVaultInput());
  const revision = await getVaultRevisionById(vault.id);

  assert.notEqual(revision, null);
  await assert.rejects(
    () => updateVaultById(vault.id, revision!, {}),
    (error) => (error as { status?: number }).status === 400,
  );
});

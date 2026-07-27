/**
 * Regression test for GET /api/organizations/:orgId/analytics (#1259).
 *
 * The handler used to aggregate from the never-populated in-memory `vaults`
 * array in routes/vaults.ts, so every org silently received zero capital and a
 * 0 success rate in production. This test exercises the real analytics route
 * against Postgres vaults created via POST /api/vaults.
 *
 * Env must be initialized before route modules are imported, because
 * orgAnalytics → db/index reads getEnv() at module evaluation time.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/disciplr_test";
process.env.DOWNLOAD_SECRET ??= "test-download-secret-at-least-16-chars";
process.env.NODE_ENV ??= "test";
process.env.FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 0).toString("base64");
process.env.JWT_SECRET ??= "change-me-in-production";

import { initEnv } from "../config/env.js";
initEnv();

import request from "supertest";
import express from "express";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  setupTestDatabase,
  teardownTestDatabase,
} from "./helpers/testDatabase.js";
import { setOrganizations, setOrgMembers } from "../models/organizations.js";
import { generateAccessToken } from "../lib/auth-utils.js";
import { UserRole } from "../types/user.js";

const { vaultsRouter } = await import("../routes/vaults.js");
const { orgAnalyticsRouter } = await import("../routes/orgAnalytics.js");
const { errorHandler } = await import("../middleware/errorHandler.js");

const stellar = (): string => `G${"A".repeat(55)}`;

const validVaultPayload = (
  orgId: string,
  overrides: Record<string, unknown> = {},
) => ({
  amount: "1000",
  startDate: "2030-01-01T00:00:00.000Z",
  endDate: "2030-06-01T00:00:00.000Z",
  verifier: stellar(),
  destinations: { success: stellar(), failure: stellar() },
  milestones: [
    {
      title: "Kickoff",
      dueDate: "2030-02-01T00:00:00.000Z",
      amount: "1000",
    },
  ],
  orgId,
  ...overrides,
});

describe("GET /api/organizations/:orgId/analytics (DB-backed)", () => {
  let db: Knex;
  let app: express.Express;

  const ORG_ID = randomUUID();
  const OTHER_ORG_ID = randomUUID();
  const USER_ID = "org-analytics-owner";
  const token = generateAccessToken({ userId: USER_ID, role: UserRole.USER });

  beforeAll(async () => {
    db = await setupTestDatabase();

    app = express();
    app.use(express.json());
    app.use("/api/vaults", vaultsRouter);
    app.use("/api/organizations", orgAnalyticsRouter);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await db("vaults").del();
    setOrganizations([
      {
        id: ORG_ID,
        name: "Analytics Org",
        createdAt: new Date().toISOString(),
      },
      {
        id: OTHER_ORG_ID,
        name: "Other Org",
        createdAt: new Date().toISOString(),
      },
    ]);
    setOrgMembers([{ orgId: ORG_ID, userId: USER_ID, role: "owner" }]);
  });

  afterEach(() => {
    setOrganizations([]);
    setOrgMembers([]);
  });

  it("computes analytics from database vaults, not the in-memory array", async () => {
    const createRes = await request(app)
      .post("/api/vaults")
      .set("Authorization", `Bearer ${token}`)
      .send(validVaultPayload(ORG_ID, { amount: "2500" }));

    expect(createRes.status).toBe(201);
    const vaultId = createRes.body.vault.id as string;

    await db("vaults").where({ id: vaultId }).update({ status: "completed" });

    await db("vaults").insert({
      id: randomUUID(),
      creator: USER_ID,
      amount: "1500",
      start_date: new Date("2030-01-01"),
      end_date: new Date("2030-06-01"),
      verifier: stellar(),
      success_destination: stellar(),
      failure_destination: stellar(),
      status: "active",
      organization_id: ORG_ID,
      late_check_in_window_secs: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });

    await db("vaults").insert({
      id: randomUUID(),
      creator: "other-user",
      amount: "9999",
      start_date: new Date("2030-01-01"),
      end_date: new Date("2030-06-01"),
      verifier: stellar(),
      success_destination: stellar(),
      failure_destination: stellar(),
      status: "failed",
      organization_id: OTHER_ORG_ID,
      late_check_in_window_secs: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/analytics`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(ORG_ID);
    expect(res.body.analytics.totalCapital).toBe("4000");
    expect(res.body.analytics.activeVaults).toBe(1);
    expect(res.body.analytics.completedVaults).toBe(1);
    expect(res.body.analytics.failedVaults).toBe(0);
    expect(res.body.analytics.successRate).toBe(1);
    expect(res.body.teamPerformance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          creator: USER_ID,
          vaultCount: 2,
          totalAmount: "4000",
          successRate: 1,
        }),
      ]),
    );
    expect(res.body.generatedAt).toBeDefined();
  });

  it("returns zeroed analytics when the org has no vaults in the database", async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ID}/analytics`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.analytics).toEqual({
      totalCapital: "0",
      successRate: 0,
      activeVaults: 0,
      completedVaults: 0,
      failedVaults: 0,
    });
    expect(res.body.teamPerformance).toEqual([]);
  });
});

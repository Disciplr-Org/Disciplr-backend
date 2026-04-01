import request from "supertest";
import { app } from "../app.js";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "change-me-in-production";

const makeToken = (role: string) =>
  jwt.sign({ userId: "test-user", role }, SECRET);

describe("Admin RBAC", () => {
  it("allows ADMIN", async () => {
    const res = await request(app)
      .get("/api/admin/audit-logs")
      .set("Authorization", `Bearer ${makeToken("ADMIN")}`);

    expect(res.status).not.toBe(403);
  });

  it("denies USER", async () => {
    const res = await request(app)
      .get("/api/admin/audit-logs")
      .set("Authorization", `Bearer ${makeToken("USER")}`);

    expect(res.status).toBe(403);
  });

  it("denies unauthenticated", async () => {
    const res = await request(app).get("/api/admin/audit-logs");

    expect(res.status).toBe(401);
  });
});

import request from "supertest";
import { app } from "../src/app.js";

describe("API Versioning", () => {
  it("should respond at /api/v1/health with Api-Version header", async () => {
    const response = await request(app).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.headers["api-version"]).toBe("v1");
    expect(response.body.status).toBe("ok");
  });

  it("should redirect GET /api/health to /api/v1/health with 307", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(307);
    expect(response.headers.location).toBe("/api/v1/health");
  });

  it("should redirect POST /api/vaults to /api/v1/vaults with 307 (method preserved)", async () => {
    const response = await request(app).post("/api/vaults").send({});

    expect(response.status).toBe(307);
    expect(response.headers.location).toBe("/api/v1/vaults");
  });

  it("should not include Api-Version header on unversioned redirect responses", async () => {
    const response = await request(app).get("/api/health");

    // The redirect itself should NOT have the Api-Version header
    // (only the final /api/v1/* response should)
    expect(response.headers["api-version"]).toBeUndefined();
  });
});

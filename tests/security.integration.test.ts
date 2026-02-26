import request from "supertest";
import { app } from "../src/app.js";

describe("Security Headers & CORS", () => {
  it("should have security headers applied via Helmet", async () => {
    const response = await request(app).get("/api/v1/health");

    // Check for specific headers mentioned in AC
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("should allow CORS from trusted origins", async () => {
    const response = await request(app)
      .get("/api/v1/health")
      .set("Origin", "http://localhost:3000");

    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
  });

  it("should block CORS from untrusted origins", async () => {
    const response = await request(app)
      .get("/api/v1/health")
      .set("Origin", "http://evil-attacker.com");

    // If blocked, the header should not be present
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

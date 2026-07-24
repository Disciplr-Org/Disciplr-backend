import { Request, Response, NextFunction } from "express";
import { getAuthenticatedUserId, authenticate } from "../middleware/auth.js";
import { jest, describe, it, expect } from "@jest/globals";

describe("Auth Middleware Consolidation", () => {
  it("authenticate rejects x-user-id header (security regression test)", async () => {
    const req = {
      header: (name: string) =>
        name === "x-user-id" ? "attacker-123" : undefined,
    } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Unauthorized: Missing or malformed Authorization header",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate rejects Authorization: Bearer user: format (security regression test)", async () => {
    const req = {
      header: (name: string) =>
        name === "authorization" ? "Bearer user:attacker-123" : undefined,
    } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate rejects missing auth", async () => {
    const req = { header: () => undefined } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("getAuthenticatedUserId reads the legacy authUser fallback", () => {
    const req = { authUser: { userId: "legacy-123" } } as any;

    expect(getAuthenticatedUserId(req)).toBe("legacy-123");
  });

  it("getAuthenticatedUserId returns null when no identity is present", () => {
    const req = {} as any;

    expect(getAuthenticatedUserId(req)).toBeNull();
  });
});

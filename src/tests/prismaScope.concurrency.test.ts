/* eslint-disable @typescript-eslint/no-explicit-any */
import { mock, describe, it, expect } from "bun:test";

// 1. Mock the global prisma singleton before importing prismaScope
const mockSingleton = { tag: "global-singleton-prisma-client" } as any;
mock.module("../lib/prisma.js", () => {
  return {
    prisma: mockSingleton,
  };
});

// 2. Now import the prismaScope module
import { prismaStorage, getPrisma } from "../lib/prismaScope.js";

describe("PrismaScope Concurrency Stress Test", () => {
  it("should return the global singleton when no scope is active", () => {
    expect(getPrisma()).toBe(mockSingleton);
  });

  it("should isolate scopes perfectly across 1000 concurrent requests with deep nesting, timer hops, and error paths", async () => {
    const totalRequests = 1000;
    const tasks: Promise<void>[] = [];

    // Helper to generate a random delay between 0 and 15ms
    const randomDelay = () => new Promise((resolve) => globalThis.setTimeout(resolve, Math.random() * 15));

    // A deeply nested async chain to verify context propagation
    async function deepNestedChain(expectedClient: any) {
      expect(getPrisma()).toBe(expectedClient);
      await randomDelay();
      expect(getPrisma()).toBe(expectedClient);

      await (async function level2() {
        expect(getPrisma()).toBe(expectedClient);
        await randomDelay();
        expect(getPrisma()).toBe(expectedClient);

        await (async function level3() {
          expect(getPrisma()).toBe(expectedClient);
          // Yield to event loop using process.nextTick
          await new Promise((resolve) => process.nextTick(resolve));
          expect(getPrisma()).toBe(expectedClient);
        })();

        expect(getPrisma()).toBe(expectedClient);
      })();

      expect(getPrisma()).toBe(expectedClient);
    }

    // An async function that throws an error to test the error path scope preservation
    async function asyncErrorThrower(expectedClient: any, tenantId: string) {
      expect(getPrisma()).toBe(expectedClient);
      // Yield using setImmediate
      await new Promise((resolve) => globalThis.setImmediate(resolve));
      expect(getPrisma()).toBe(expectedClient);
      throw new Error(`Error from ${tenantId}`);
    }

    // Simulate a single request lifecycle
    async function simulateRequest(tenantId: string) {
      const client = { tag: tenantId } as any;

      await new Promise<void>((resolve, reject) => {
        prismaStorage.run({ prisma: client }, async () => {
          try {
            // Initial check
            expect(getPrisma()).toBe(client);

            // 1. Test deep nesting and random timer hops (setTimeout / process.nextTick)
            await deepNestedChain(client);

            // 2. Test another event loop hop (setImmediate)
            await new Promise((resolveHop) => globalThis.setImmediate(resolveHop));
            expect(getPrisma()).toBe(client);

            // 3. Test error path scope isolation
            try {
              await asyncErrorThrower(client, tenantId);
              reject(new Error("Should have thrown an error"));
            } catch (err: any) {
              // Ensure we caught the right error
              expect(err.message).toBe(`Error from ${tenantId}`);
              // CRITICAL: Ensure the scope is still bound to the correct client in the catch block
              expect(getPrisma()).toBe(client);
            }

            // 4. Ensure scope is still intact after error handling
            expect(getPrisma()).toBe(client);

            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });

      // Outside the scope, getPrisma should fallback to the global singleton or outer scope
      expect(getPrisma()).toBe(mockSingleton);
    }

    // Launch 1000 concurrent requests simultaneously
    for (let i = 1; i <= totalRequests; i++) {
      tasks.push(simulateRequest(`tenant-${i}`));
    }

    // Wait for all of them to complete
    await Promise.all(tasks);

    // Final check: outside of all runs, getPrisma must be the singleton
    expect(getPrisma()).toBe(mockSingleton);
  });
});

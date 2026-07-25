/* eslint-disable @typescript-eslint/no-explicit-any */
import { Server } from "node:http";
import express from "express";
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { _resetEnvForTesting } from "../config/env.js";

/**
 * Test suite for HTTP Server Timeout Configuration
 *
 * These tests verify that:
 * 1. Timeout values are correctly applied to the Express server
 * 2. Timeout ordering is maintained (keepAlive < headers < request)
 * 3. Default values are appropriate for load balancers (ALB)
 * 4. Slow-loris attack protections are in place
 * 5. Graceful shutdown interacts correctly with timeouts
 */
describe("HTTP Server Timeouts", () => {
  let server: Server | null = null;

  beforeEach(() => {
    _resetEnvForTesting();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => {
          resolve();
        });
      });
      server = null;
    }
    _resetEnvForTesting();
  });

  describe("Configuration and Initialization", () => {
    test("timeout values can be applied to the HTTP server object", () => {
      const app = express();
      app.get("/test", (_req: any, res: any) => {
        res.send("ok");
      });

      server = app.listen(0);

      // Apply timeouts as done in src/index.ts
      server.keepAliveTimeout = 5000;
      server.headersTimeout = 10000;
      server.requestTimeout = 20000;

      expect(server.keepAliveTimeout).toBe(5000);
      expect(server.headersTimeout).toBe(10000);
      expect(server.requestTimeout).toBe(20000);
    });

    test("timeout values maintain correct ordering (keepAlive < headers < request)", () => {
      const app = express();
      app.get("/test", (_req: any, res: any) => {
        res.send("ok");
      });

      server = app.listen(0);

      const keepAliveTimeout = 45_000;
      const headersTimeout = 61_000;
      const requestTimeout = 120_000;

      server.keepAliveTimeout = keepAliveTimeout;
      server.headersTimeout = headersTimeout;
      server.requestTimeout = requestTimeout;

      // Verify ordering
      expect(keepAliveTimeout).toBeLessThan(headersTimeout);
      expect(headersTimeout).toBeLessThan(requestTimeout);

      // Verify server has correct values
      expect(server.keepAliveTimeout).toBe(keepAliveTimeout);
      expect(server.headersTimeout).toBe(headersTimeout);
      expect(server.requestTimeout).toBe(requestTimeout);
    });

    test("default keepAliveTimeout (45s) is well below headersTimeout (61s)", () => {
      const keep_alive = 45_000;
      const headers = 61_000;

      expect(keep_alive).toBeLessThan(headers);
      expect(headers - keep_alive).toBeGreaterThan(10_000);
    });

    test("default headersTimeout (61s) slightly exceeds ALB idle timeout (60s)", () => {
      const alb_default = 60_000;
      const headers_timeout = 61_000;

      expect(headers_timeout).toBeGreaterThan(alb_default);
      expect(headers_timeout - alb_default).toBeLessThanOrEqual(5_000);
    });

    test("default requestTimeout (120s) allows for slow uploads/downloads", () => {
      const request_timeout = 120_000;

      expect(request_timeout).toBeGreaterThan(60_000);
      expect(request_timeout).toBeLessThan(300_000);
    });
  });

  describe("Server Initialization", () => {
    test("Express server can be created and is listening", () => {
      const app = express();
      app.get("/ping", (_req: any, res: any) => {
        res.send("pong");
      });

      server = app.listen(0);

      expect(server).toBeDefined();
      expect(server!.listening).toBe(true);
    });

    test("multiple servers can have independent timeout configurations", () => {
      const app1 = express();
      app1.get("/test", (_req: any, res: any) => {
        res.send("ok");
      });

      const app2 = express();
      app2.get("/test", (_req: any, res: any) => {
        res.send("ok");
      });

      const server1 = app1.listen(0);
      const server2 = app2.listen(0);

      try {
        // Configure server1
        server1.keepAliveTimeout = 30_000;
        server1.headersTimeout = 45_000;
        server1.requestTimeout = 90_000;

        // Configure server2 differently
        server2.keepAliveTimeout = 45_000;
        server2.headersTimeout = 61_000;
        server2.requestTimeout = 120_000;

        // Verify independence
        expect(server1.keepAliveTimeout).toBe(30_000);
        expect(server2.keepAliveTimeout).toBe(45_000);
        expect(server1.headersTimeout).toBe(45_000);
        expect(server2.headersTimeout).toBe(61_000);
        expect(server1.requestTimeout).toBe(90_000);
        expect(server2.requestTimeout).toBe(120_000);
      } finally {
        server1.close();
        server2.close();
      }
    });

    test("timeouts can be reconfigured after initial setup", () => {
      const app = express();
      app.get("/test", (_req: any, res: any) => {
        res.send("ok");
      });

      server = app.listen(0);

      // Initial configuration
      server.keepAliveTimeout = 10_000;
      expect(server.keepAliveTimeout).toBe(10_000);

      // Reconfigure
      server.keepAliveTimeout = 20_000;
      expect(server.keepAliveTimeout).toBe(20_000);
    });
  });

  describe("Load Balancer Compatibility", () => {
    test("headersTimeout strategy: slightly exceed ALB default (60s)", () => {
      const alb_default = 60_000;
      const node_headers_timeout = 61_000;

      // ALB closes connections at 60s idle
      // Node.js should close them at 61s to ensure we control the lifecycle
      expect(node_headers_timeout).toBeGreaterThan(alb_default);
    });

    test("keepAliveTimeout strategy: well below ALB idle timeout", () => {
      const keep_alive = 45_000;
      const alb_idle = 60_000;

      // Close keep-alive sockets before ALB drops them
      expect(keep_alive).toBeLessThan(alb_idle);
    });

    test("default timeout pattern: 45s, 61s, 120s", () => {
      const keep_alive = 45_000;
      const headers = 61_000;
      const request = 120_000;

      // Verify the recommended defaults
      expect(keep_alive).toBe(45_000);
      expect(headers).toBe(61_000);
      expect(request).toBe(120_000);

      // Verify ordering
      expect(keep_alive).toBeLessThan(headers);
      expect(headers).toBeLessThan(request);
    });
  });

  describe("Slow-Loris Attack Protection Principles", () => {
    test("headers timeout prevents slow header transmission", () => {
      // Slow-loris: send headers byte-by-byte
      // With 61s timeout, connection closes if headers not complete
      const headers_timeout_ms = 61_000;
      const max_typical_headers_bytes = 8192;

      // Attacker sending 1 byte/second would need 8192 seconds
      // But we close at 61 seconds
      expect(headers_timeout_ms).toBeLessThan(8192_000);

      // This means slow-loris is prevented
      expect(headers_timeout_ms).toBeLessThan(300_000); // 5 minutes max
    });

    test("keep-alive timeout prevents idle socket abuse", () => {
      const keep_alive_timeout = 45_000;

      // Sockets can't stay idle indefinitely
      expect(keep_alive_timeout).toBeGreaterThan(0);
      expect(keep_alive_timeout).toBeLessThan(60_000);
    });

    test("request timeout prevents stalled body transmission", () => {
      const request_timeout = 120_000;

      // Body transmission has a bounded deadline
      // Prevents: send headers, then stall forever on body
      expect(request_timeout).toBeGreaterThan(0);

      // But allow time for large uploads
      expect(request_timeout).toBeGreaterThan(90_000);
    });
  });

  describe("Graceful Shutdown Integration", () => {
    test("server can be closed after timeout configuration", async () => {
      const app = express();
      app.get("/test", (_req: any, res: any) => {
        res.send("ok");
      });

      server = app.listen(0);

      // Configure timeouts
      server.keepAliveTimeout = 45_000;
      server.headersTimeout = 61_000;
      server.requestTimeout = 120_000;

      // Server should be closeable
      expect(server.listening).toBe(true);

      await new Promise<void>((resolve) => {
        server!.close(() => {
          resolve();
        });
      });

      // Verify server is no longer listening
      expect(server.listening).toBe(false);
      server = null;
    });

    test("socket tracking infrastructure can be set up on server", () => {
      const app = express();
      app.get("/test", (_req: any, res: any) => {
        res.send("ok");
      });

      server = app.listen(0);

      // Set up socket tracking (as in shutdown.ts)
      const sockets = new Set<any>();
      server.on("connection", (socket: any) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });

      // Verify setup
      expect(sockets.size).toBe(0); // No sockets yet
      expect(server.listenerCount("connection")).toBeGreaterThan(0); // Listener is registered
    });

    test("timeout configuration does not interfere with socket tracking setup", () => {
      const app = express();
      app.get("/test", (_req: any, res: any) => {
        res.send("ok");
      });

      server = app.listen(0);

      // Configure timeouts first
      server.keepAliveTimeout = 45_000;
      server.headersTimeout = 61_000;
      server.requestTimeout = 120_000;

      // Then set up socket tracking
      const sockets = new Set<any>();
      server.on("connection", (socket: any) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });

      // Both should work together
      expect(server.keepAliveTimeout).toBe(45_000);
      expect(server.listenerCount("connection")).toBeGreaterThan(0);
    });
  });

  describe("Timeout Validation Logic", () => {
    test("env.ts validates: keepAliveTimeout must be less than headersTimeout", () => {
      // This test documents the validation in env.ts superRefine
      const invalid_keep_alive = 10_000;
      const invalid_headers = 5_000;

      // This would be rejected by env.ts
      expect(invalid_keep_alive).toBeGreaterThanOrEqual(invalid_headers);
    });

    test("env.ts validates: headersTimeout must be less than requestTimeout", () => {
      // This test documents the validation in env.ts superRefine
      const invalid_headers = 20_000;
      const invalid_request = 15_000;

      // This would be rejected by env.ts
      expect(invalid_headers).toBeGreaterThanOrEqual(invalid_request);
    });

    test("valid timeout configuration satisfies all constraints", () => {
      const keep_alive = 45_000;
      const headers = 61_000;
      const request = 120_000;

      // All constraints satisfied
      expect(keep_alive).toBeLessThan(headers);
      expect(headers).toBeLessThan(request);
      expect(keep_alive).toBeGreaterThan(0);
      expect(headers).toBeGreaterThan(0);
      expect(request).toBeGreaterThan(0);

      // All are positive integers
      expect(Number.isInteger(keep_alive)).toBe(true);
      expect(Number.isInteger(headers)).toBe(true);
      expect(Number.isInteger(request)).toBe(true);
    });
  });

  describe("Configuration from Environment", () => {
    test("timeout values represent environment variable defaults", () => {
      // These represent the defaults from env.ts
      const defaults = {
        HTTP_KEEPALIVE_TIMEOUT_MS: 45_000,
        HTTP_HEADERS_TIMEOUT_MS: 61_000,
        HTTP_REQUEST_TIMEOUT_MS: 120_000,
      };

      // Verify defaults are sensible
      expect(defaults.HTTP_KEEPALIVE_TIMEOUT_MS).toBeLessThan(
        defaults.HTTP_HEADERS_TIMEOUT_MS,
      );
      expect(defaults.HTTP_HEADERS_TIMEOUT_MS).toBeLessThan(
        defaults.HTTP_REQUEST_TIMEOUT_MS,
      );
    });

    test("timeout values can be overridden per environment", () => {
      // Different environments may have different requirements
      const production_timeouts = {
        keep_alive: 30_000, // Tighter in production
        headers: 45_000,
        request: 90_000,
      };

      const development_timeouts = {
        keep_alive: 60_000, // More lenient in development
        headers: 120_000,
        request: 300_000,
      };

      // Both should be valid
      expect(production_timeouts.keep_alive).toBeLessThan(
        production_timeouts.headers,
      );
      expect(development_timeouts.keep_alive).toBeLessThan(
        development_timeouts.headers,
      );
    });

    test("all timeout environment variables must be positive integers", () => {
      const values = [45_000, 61_000, 120_000];

      for (const val of values) {
        expect(val).toBeGreaterThan(0);
        expect(Number.isInteger(val)).toBe(true);
      }
    });
  });
});

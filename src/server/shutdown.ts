import type { Server } from "node:http";
import { BackgroundJobSystem } from "../jobs/system.js";
import { ETLWorker } from "../services/etlWorker.js";
import {
  getInFlightCount,
  setDraining,
} from "../middleware/inFlightRequests.js";
import { getEnv } from "../config/index.js";

export interface ShutdownOptions {
  server: Server;
  jobSystem: BackgroundJobSystem;
  etlWorker: ETLWorker;
  closeDb: () => void;
}

/**
 * Creates a graceful shutdown handler with all necessary dependencies.
 *
 * Execution order:
 * 1. Stop ETL worker (prevents new syncs).
 * 2. Stop Job System (prevents new jobs, waits for active ones).
 * 3. Close HTTP server (prevents new requests).
 * 4. Close Database connection.
 *
 * HTTP Timeout Interaction:
 * The graceful shutdown process respects the server's configured timeouts:
 *   - keepAliveTimeout: Controls how long a socket can be idle before being destroyed.
 *     During shutdown, the drain phase waits for in-flight requests to complete.
 *     If the drain deadline (SHUTDOWN_DRAIN_MS) expires, sockets are force-destroyed.
 *   - headersTimeout: The server-level timeout for receiving complete HTTP headers.
 *     If a client stalls sending headers after SIGTERM, they will be disconnected
 *     by the headersTimeout, not by graceful shutdown.
 *   - requestTimeout: The full request lifecycle timeout. Ensures even if headers
 *     are received, a stalled client uploading/downloading will timeout.
 *
 * Best practice: Set SHUTDOWN_DRAIN_MS < (keepAliveTimeout - headersTimeout)
 * to allow the drain phase to complete before sockets are naturally destroyed.
 */
export function createShutdownHandler(options: ShutdownOptions) {
  const { server, jobSystem, etlWorker, closeDb } = options;
  let shuttingDown = false;
  // Track open sockets so we can force-close them if the drain deadline expires
  const sockets = new Set<any>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[Shutdown] Received ${signal}. Starting graceful shutdown...`);

    try {
      // 1. Stop ETL Worker
      console.log("[Shutdown] Stopping ETL worker...");
      await etlWorker.stop();

      // 1.5 Enter HTTP drain mode: stop accepting new requests at middleware level
      try {
        const env = getEnv();
        const drainMs = env.SHUTDOWN_DRAIN_MS ?? 30_000;
        console.log(
          `[Shutdown] Entering HTTP drain mode (waiting up to ${drainMs}ms for in-flight requests)`,
        );
        setDraining(true);

        const start = Date.now();
        while (getInFlightCount() > 0 && Date.now() - start < drainMs) {
          // wait a short interval
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 100));
        }

        if (getInFlightCount() > 0) {
          console.warn(
            "[Shutdown] Drain deadline reached; forcing close of remaining connections",
          );
          for (const s of sockets) {
            try {
              s.destroy();
            } catch (e) {
              // ignore
            }
          }
        } else {
          console.log("[Shutdown] All in-flight requests completed");
        }
      } finally {
        // leave draining mode so middleware behaves normally in tests after shutdown
        setDraining(false);
      }

      // 2. Stop Job System
      console.log("[Shutdown] Stopping background job system...");
      await jobSystem.stop();

      // 3. Close HTTP Server
      console.log("[Shutdown] Closing HTTP server...");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      console.log("[Shutdown] HTTP server closed");

      // 4. Close Database
      console.log("[Shutdown] Closing database connection...");
      closeDb();

      console.log("[Shutdown] Graceful shutdown completed successfully");
      process.exit(0);
    } catch (error) {
      console.error("[Shutdown] Failed during graceful shutdown:", error);
      process.exit(1);
    }
  };
}

import { initEnv, getEnv } from "./config/index.js";

// Validate environment variables before any other initialisation.
// This ensures the process exits immediately on misconfiguration.
initEnv();

import { ensureSorobanBootPrecheck } from "./services/sorobanBoot.js";

import { app } from "./app.js";
import { bootstrapApp } from "./app-bootstrap.js";
import { startExpirationChecker } from "./services/expirationScheduler.js";
import { orgVaultsRouter } from "./routes/orgVaults.js";
import { orgAnalyticsRouter } from "./routes/orgAnalytics.js";
import { orgMembersRouter } from "./routes/orgMembers.js";
import { adminRouter } from "./routes/admin.js";
import { adminVerifiersRouter } from "./routes/adminVerifiers.js";
import { verificationsRouter } from "./routes/verifications.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { notificationsRouter } from "./routes/notifications.js";
import {
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} from "./security/abuse-monitor.js";
import { initializeDatabase, closeDatabase } from "./db/database.js";
import { etlWorker } from "./services/etlWorker.js";
import { createShutdownHandler } from "./server/shutdown.js";
import { getEnv } from "./config/index.js";
import { createNotificationService } from "./services/notifications/factory.js";

const env = getEnv();
const PORT = env.PORT;

// Initialize SQLite database for analytics
initializeDatabase();

const env = getEnv();
const notificationService = createNotificationService(
  env.NOTIFICATION_PROVIDER,
);
const { jobSystem } = bootstrapApp({ notificationService });

jobSystem.start();

const ETL_INTERVAL_MINUTES = env.ETL_INTERVAL_MINUTES;

const server = app.listen(PORT, () => {
  console.log(`Disciplr API listening on http://localhost:${PORT}`);
  startExpirationChecker();
  if (env.ENABLE_ETL_WORKER !== "false") {
    etlWorker.start(ETL_INTERVAL_MINUTES);
  }
  void ensureSorobanBootPrecheck();
});

// ──────────────────────────────────────────────────────────────────────────
// Configure HTTP request timeouts to defend against slow-loris attacks
// and load balancer connection drops.
//
// Sequence: keepAliveTimeout < headersTimeout < requestTimeout
//   - keepAliveTimeout (45s): Socket idle threshold; if no data arrives
//     before this, the socket is terminated (prevents lingering idle sockets).
//   - headersTimeout (61s): HTTP headers deadline; if complete headers don't
//     arrive by this point, the socket is destroyed (Node.js server-level).
//   - requestTimeout (120s): Full request lifecycle timeout; if the request
//     is not completed (headers + body) by this point, socket is destroyed.
//
// Defaults accommodate typical load balancer idle timeouts (ALB: 60s).
// ──────────────────────────────────────────────────────────────────────────
server.keepAliveTimeout = env.HTTP_KEEPALIVE_TIMEOUT_MS;
server.headersTimeout = env.HTTP_HEADERS_TIMEOUT_MS;
server.requestTimeout = env.HTTP_REQUEST_TIMEOUT_MS;

console.log("[Server] Configured HTTP timeouts:", {
  keepAliveTimeout: `${server.keepAliveTimeout}ms`,
  headersTimeout: `${server.headersTimeout}ms`,
  requestTimeout: `${server.requestTimeout}ms`,
});

const shutdownHandler = createShutdownHandler({
  server,
  jobSystem,
  etlWorker,
  closeDb: closeDatabase,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdownHandler(signal);
  });
}

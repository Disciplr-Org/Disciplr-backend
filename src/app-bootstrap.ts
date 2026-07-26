import { app } from './app.js'
import { errorHandler } from './middleware/errorHandler.js'
import { notFound } from './middleware/notFound.js'
import { vaultsRouter } from './routes/vaults.js'
import { createHealthRouter } from './routes/health.js'
import { createJobsRouter } from './routes/jobs.js'
import { BackgroundJobSystem } from './jobs/system.js'
import { authRouter } from './routes/auth.js'
import { analyticsRouter } from './routes/analytics.js'
import { authRateLimiter, healthRateLimiter, vaultsRateLimiter } from './middleware/rateLimiter.js'
import { createExportRouter } from './routes/exports.js'
import { configureExportJobRepository, configureDlqRepository, createKnexExportJobRepository, createKnexDlqRepository } from './services/exportQueue.js'
import { db } from './db/index.js'
import { transactionsRouter } from './routes/transactions.js'
import { privacyRouter, privacyAbuseMonitor } from './routes/privacy.js'
import { milestonesRouter } from './routes/milestones.js'
import { orgVaultsRouter } from './routes/orgVaults.js'
import { orgAnalyticsRouter } from './routes/orgAnalytics.js'
import { orgMembersRouter } from './routes/orgMembers.js'
// adminRouter is imported and mounted in app.ts; not needed here.
import { adminVerifiersRouter } from './routes/adminVerifiers.js'
import { adminWebhooksRouter, adminVaultReplayRouter } from './routes/adminWebhooks.js'
import { verificationsRouter } from './routes/verifications.js'
import { apiKeysRouter, getApiKeyUsageHandler } from './routes/apiKeys.js'
import { oauthRouter } from './routes/oauth.js'
import { authenticate } from './middleware/auth.js'
import { requireOrgAccess } from './middleware/orgAuth.js'
// notificationsRouter is imported and mounted in app.ts; not needed here.
import { notificationPreferencesRouter } from './routes/notificationPreferences.js'
// webhookRouter is mounted in app.ts at module load time; no re-mount needed here.
import { graphqlRouter } from './routes/graphql.js'
import { createNotificationService, NotificationService } from './services/notifications/factory.js'
import { withRequestPrisma } from './middleware/withRequestPrisma.js'
import {
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} from "./security/abuse-monitor.js";
import inFlightMiddleware from "./middleware/inFlightRequests.js";
import { mountVersionedRoute } from './middleware/versioning.js'

type BootstrapOptions = {
  notificationService?: NotificationService;
  notificationProviderName?: string;
};

export function bootstrapApp(options: BootstrapOptions = {}) {
  const notificationService =
    options.notificationService ??
    createNotificationService(
      options.notificationProviderName ??
        process.env.NOTIFICATION_PROVIDER ??
        "console",
    );
  const jobSystem = new BackgroundJobSystem(notificationService);
  configureExportJobRepository(createKnexExportJobRepository(db))
  configureDlqRepository(createKnexDlqRepository(db))

  app.use(securityMetricsMiddleware);
  app.use(securityRateLimitMiddleware);
  // Track in-flight requests for graceful shutdown
  app.use(inFlightMiddleware);
  app.use(withRequestPrisma);

  // Mount all routes through mountVersionedRoute so that:
  //   /api/v1/<resource>  — canonical versioned path (no deprecation headers)
  //   /api/<resource>     — legacy alias (Deprecation + Sunset + Link headers)
  // This satisfies issue #1257: legacy routes now emit the RFC 8594 warning
  // headers that versioning.ts was built to provide, and clients have a
  // /api/v1/... surface to migrate to.
  mountVersionedRoute(app, '/api/health', '/api/v1/health', healthRateLimiter, createHealthRouter(jobSystem, privacyAbuseMonitor))
  mountVersionedRoute(app, '/api/jobs', '/api/v1/jobs', createJobsRouter(jobSystem))
  mountVersionedRoute(app, '/api/vaults', '/api/v1/vaults', vaultsRateLimiter, vaultsRouter)
  mountVersionedRoute(app, '/api/vaults/:vaultId/milestones', '/api/v1/vaults/:vaultId/milestones', milestonesRouter)
  mountVersionedRoute(app, '/api/auth', '/api/v1/auth', authRateLimiter, authRouter)
  mountVersionedRoute(app, '/api/exports', '/api/v1/exports', createExportRouter(jobSystem))
  mountVersionedRoute(app, '/api/transactions', '/api/v1/transactions', transactionsRouter)
  mountVersionedRoute(app, '/api/analytics', '/api/v1/analytics', analyticsRouter)
  mountVersionedRoute(app, '/api/privacy', '/api/v1/privacy', privacyRouter)
  mountVersionedRoute(app, '/api/organizations', '/api/v1/organizations', orgVaultsRouter)
  mountVersionedRoute(app, '/api/organizations', '/api/v1/organizations', orgAnalyticsRouter)
  mountVersionedRoute(app, '/api/orgs', '/api/v1/orgs', orgAnalyticsRouter)
  mountVersionedRoute(app, '/api/organizations', '/api/v1/organizations', orgMembersRouter)
  mountVersionedRoute(app, '/api/orgs', '/api/v1/orgs', orgMembersRouter)
  mountVersionedRoute(app, '/api/orgs', '/api/v1/orgs', notificationPreferencesRouter)
  mountVersionedRoute(app, '/api/organizations/:orgId/graphql', '/api/v1/organizations/:orgId/graphql', graphqlRouter)
  // /api/admin is mounted in app.ts at module load time; not needed here.
  mountVersionedRoute(app, '/api/admin/verifiers', '/api/v1/admin/verifiers', adminVerifiersRouter)
  mountVersionedRoute(app, '/api/admin/webhooks', '/api/v1/admin/webhooks', adminWebhooksRouter)
  mountVersionedRoute(app, '/api/admin/vaults', '/api/v1/admin/vaults', adminVaultReplayRouter)
  mountVersionedRoute(app, '/api/verifications', '/api/v1/verifications', verificationsRouter)
  app.get('/api/orgs/:orgId/api-keys/usage', authenticate, requireOrgAccess('owner', 'admin'), getApiKeyUsageHandler)
  app.get('/api/v1/orgs/:orgId/api-keys/usage', authenticate, requireOrgAccess('owner', 'admin'), getApiKeyUsageHandler)
  mountVersionedRoute(app, '/api/api-keys', '/api/v1/api-keys', apiKeysRouter)
  mountVersionedRoute(app, '/api/oauth', '/api/v1/oauth', oauthRouter)
  // /api/notifications is mounted in app.ts at module load time; not needed here.
  mountVersionedRoute(app, '/api/users/me/notification-preferences', '/api/v1/users/me/notification-preferences', notificationPreferencesRouter)
  // /api/webhooks is mounted in app.ts at module load time; not needed here.

  // Catch-all 404 and uniform error shape – must be registered after all routes.
  app.use(notFound);
  app.use(errorHandler);

  return { app, jobSystem };
}

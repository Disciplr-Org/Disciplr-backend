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
import { configureOrgQuotaRepository, createKnexOrgQuotaRepository } from './services/exportQuota.js'
import { db } from './db/index.js'
import { transactionsRouter } from './routes/transactions.js'
import { privacyRouter, privacyAbuseMonitor } from './routes/privacy.js'
import { milestonesRouter } from './routes/milestones.js'
import { orgVaultsRouter } from './routes/orgVaults.js'
import { orgAnalyticsRouter } from './routes/orgAnalytics.js'
import { orgMembersRouter } from './routes/orgMembers.js'
import { adminRouter } from './routes/admin.js'
import { adminVerifiersRouter } from './routes/adminVerifiers.js'
import { adminWebhooksRouter, adminVaultReplayRouter } from './routes/adminWebhooks.js'
import { verificationsRouter } from './routes/verifications.js'
import { apiKeysRouter, getApiKeyUsageHandler } from './routes/apiKeys.js'
import { oauthRouter } from './routes/oauth.js'
import { authenticate } from './middleware/auth.js'
import { requireOrgAccess } from './middleware/orgAuth.js'
import { notificationsRouter } from './routes/notifications.js'
import { notificationPreferencesRouter } from './routes/notificationPreferences.js'
import { webhookRouter } from './routes/webhooks.js'
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
  const jobSystem = new BackgroundJobSystem(notificationService, undefined, privacyAbuseMonitor);
  configureExportJobRepository(createKnexExportJobRepository(db))
  configureDlqRepository(createKnexDlqRepository(db))
  configureOrgQuotaRepository(createKnexOrgQuotaRepository(db))

  app.use(securityMetricsMiddleware);
  app.use(securityRateLimitMiddleware);
  // Track in-flight requests for graceful shutdown
  app.use(inFlightMiddleware);
  app.use(withRequestPrisma);

  // ── Versioned routes ──────────────────────────────────────────────────────
  // Each route is mounted at both /api/v1/<resource> (canonical, no headers)
  // and /api/<resource> (legacy, with RFC 8594 Deprecation/Sunset/Link headers).
  mountVersionedRoute(app, '/api/health', '/api/v1/health', healthRateLimiter, createHealthRouter(jobSystem, privacyAbuseMonitor))
  mountVersionedRoute(app, '/api/jobs', '/api/v1/jobs', createJobsRouter(jobSystem))
  mountVersionedRoute(app, '/api/vaults', '/api/v1/vaults', vaultsRateLimiter, vaultsRouter)
  mountVersionedRoute(app, '/api/vaults/:vaultId/milestones', '/api/v1/vaults/:vaultId/milestones', milestonesRouter)
  mountVersionedRoute(app, '/api/auth', '/api/v1/auth', authRouter)
  mountVersionedRoute(app, '/api/exports', '/api/v1/exports', createExportRouter(jobSystem))
  mountVersionedRoute(app, '/api/transactions', '/api/v1/transactions', transactionsRouter)
  mountVersionedRoute(app, '/api/analytics', '/api/v1/analytics', analyticsRouter)
  mountVersionedRoute(app, '/api/privacy', '/api/v1/privacy', privacyRouter)
  mountVersionedRoute(app, '/api/organizations', '/api/v1/organizations', orgVaultsRouter)
  mountVersionedRoute(app, '/api/organizations', '/api/v1/organizations', orgAnalyticsRouter)
  mountVersionedRoute(app, '/api/orgs', '/api/v1/orgs', orgAnalyticsRouter)
  mountVersionedRoute(app, '/api/organizations', '/api/v1/organizations', orgMembersRouter)
  mountVersionedRoute(app, '/api/orgs', '/api/v1/orgs', orgMembersRouter)
  mountVersionedRoute(app, '/api/organizations/:orgId/graphql', '/api/v1/organizations/:orgId/graphql', graphqlRouter)
  mountVersionedRoute(app, '/api/admin', '/api/v1/admin', adminRouter)
  mountVersionedRoute(app, '/api/admin/verifiers', '/api/v1/admin/verifiers', adminVerifiersRouter)
  mountVersionedRoute(app, '/api/admin/webhooks', '/api/v1/admin/webhooks', adminWebhooksRouter)
  mountVersionedRoute(app, '/api/verifications', '/api/v1/verifications', verificationsRouter)
  mountVersionedRoute(app, '/api/api-keys', '/api/v1/api-keys', apiKeysRouter)
  mountVersionedRoute(app, '/api/notifications', '/api/v1/notifications', notificationsRouter)
  mountVersionedRoute(app, '/api/users/me/notification-preferences', '/api/v1/users/me/notification-preferences', notificationPreferencesRouter)
  mountVersionedRoute(app, '/api/webhooks', '/api/v1/webhooks', webhookRouter)

  // Catch-all 404 and uniform error shape – must be registered after all routes.
  app.use(notFound);
  app.use(errorHandler);

  return { app, jobSystem };
}

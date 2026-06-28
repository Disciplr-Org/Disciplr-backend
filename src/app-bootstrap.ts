import { app } from './app.js'
import { errorHandler } from './middleware/errorHandler.js'
import { notFound } from './middleware/notFound.js'
import { vaultsRouter } from './routes/vaults.js'
import { createHealthRouter } from './routes/health.js'
import { createJobsRouter } from './routes/jobs.js'
import { BackgroundJobSystem } from './jobs/system.js'
import { authRouter } from './routes/auth.js'
import { analyticsRouter } from './routes/analytics.js'
import { healthRateLimiter, vaultsRateLimiter } from './middleware/rateLimiter.js'
import { createExportRouter } from './routes/exports.js'
import { configureExportJobRepository, createKnexExportJobRepository } from './services/exportQueue.js'
import { db } from './db/index.js'
import { transactionsRouter } from './routes/transactions.js'
import { privacyRouter, privacyAbuseMonitor } from './routes/privacy.js'
import { milestonesRouter } from './routes/milestones.js'
import { orgVaultsRouter } from './routes/orgVaults.js'
import { orgAnalyticsRouter } from './routes/orgAnalytics.js'
import { orgMembersRouter } from './routes/orgMembers.js'
import { adminRouter } from './routes/admin.js'
import { adminVerifiersRouter } from './routes/adminVerifiers.js'
import { adminWebhooksRouter } from './routes/adminWebhooks.js'
import { verificationsRouter } from './routes/verifications.js'
import { apiKeysRouter } from './routes/apiKeys.js'
import { notificationsRouter } from './routes/notifications.js'
import { notificationPreferencesRouter } from './routes/notificationPreferences.js'
import { webhooksRouter } from './routes/webhooks.js'
import { graphqlRouter } from './routes/graphql.js'
import { createNotificationService, NotificationService } from './services/notifications/factory.js'
import { withRequestPrisma } from './middleware/withRequestPrisma.js'
import {
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} from "./security/abuse-monitor.js";
import inFlightMiddleware from "./middleware/inFlightRequests.js";

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
  configureExportJobRepository(createKnexExportJobRepository(db));

  app.use(securityMetricsMiddleware);
  app.use(securityRateLimitMiddleware);
  // Track in-flight requests for graceful shutdown
  app.use(inFlightMiddleware);
  app.use(withRequestPrisma);

  app.use('/api/health', healthRateLimiter, createHealthRouter(jobSystem, privacyAbuseMonitor))
  app.use('/api/jobs', createJobsRouter(jobSystem))
  app.use('/api/vaults', vaultsRateLimiter, vaultsRouter)
  app.use('/api/vaults/:vaultId/milestones', milestonesRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/exports', createExportRouter(jobSystem))
  app.use('/api/transactions', transactionsRouter)
  app.use('/api/analytics', analyticsRouter)
  app.use('/api/privacy', privacyRouter)
  app.use('/api/organizations', orgVaultsRouter)
  app.use('/api/organizations', orgAnalyticsRouter)
  app.use('/api/organizations', orgMembersRouter)
  app.use('/api/orgs', orgMembersRouter)
  app.use('/api/orgs', notificationPreferencesRouter)
  app.use('/api/organizations/:orgId/graphql', graphqlRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api/admin/verifiers', adminVerifiersRouter)
  app.use('/api/admin/webhooks', adminWebhooksRouter)
  app.use('/api/verifications', verificationsRouter)
  app.use('/api/api-keys', apiKeysRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/users/me/notification-preferences', notificationPreferencesRouter)
  app.use('/api/webhooks', webhooksRouter)

  // Catch-all 404 and uniform error shape – must be registered after all routes.
  app.use(notFound);
  app.use(errorHandler);

  return { app, jobSystem };
}

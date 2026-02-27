import { app } from './app.js'
import { vaultsRouter } from './routes/vaults.js'
import { createHealthRouter } from './routes/health.js'
import { createJobsRouter } from './routes/jobs.js'
import { BackgroundJobSystem } from './jobs/system.js'
import { authRouter } from './routes/auth.js'
import { analyticsRouter } from './routes/analytics.js'
import { healthRateLimiter, vaultsRateLimiter } from './middleware/rateLimiter.js'
import { createExportRouter } from './routes/exports.js'
import { transactionsRouter } from './routes/transactions.js'
import { privacyRouter } from './routes/privacy.js'
import { milestonesRouter } from './routes/milestones.js'
import { startExpirationChecker } from './services/expirationScheduler.js'
import { orgVaultsRouter } from './routes/orgVaults.js'
import { orgAnalyticsRouter } from './routes/orgAnalytics.js'
import { adminRouter } from './routes/admin.js'
import { adminVerifiersRouter } from './routes/adminVerifiers.js'
import { verificationsRouter } from './routes/verifications.js'
import { apiKeysRouter } from './routes/apiKeys.js'
import { notificationsRouter } from './routes/notifications.js'
import {
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} from './security/abuse-monitor.js'
import { initializeDatabase } from './db/database.js'

const PORT = process.env.PORT ?? 3000
const jobSystem = new BackgroundJobSystem()

jobSystem.start()

// Initialize SQLite database for analytics
initializeDatabase()

app.use(securityMetricsMiddleware)
app.use(securityRateLimitMiddleware)

app.use('/api/health', healthRateLimiter, createHealthRouter(jobSystem))
app.use('/api/jobs', createJobsRouter(jobSystem))
app.use('/api/vaults', vaultsRateLimiter, vaultsRouter)
app.use('/api/vaults/:vaultId/milestones', milestonesRouter)
app.use('/api/auth', authRouter)
app.use('/api/exports', createExportRouter([]))
app.use('/api/transactions', transactionsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/privacy', privacyRouter)
app.use('/api/organizations', orgVaultsRouter)
app.use('/api/organizations', orgAnalyticsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/admin/verifiers', adminVerifiersRouter)
app.use('/api/verifications', verificationsRouter)
app.use('/api/api-keys', apiKeysRouter)
app.use('/api/notifications', notificationsRouter)

const server = app.listen(PORT, () => {
  console.log(`Disciplr API listening on http://localhost:${PORT}`)
  startExpirationChecker()
})

let shuttingDown = false

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  console.log(`Received ${signal}. Shutting down gracefully...`)

  try {
    await jobSystem.stop()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    process.exit(0)
  } catch (error) {
    console.error('Failed during shutdown:', error)
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}

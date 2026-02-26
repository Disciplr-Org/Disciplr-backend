import { app } from './app.js'
import { vaultsRouter } from './routes/vaults.js'
import { createHealthRouter } from './routes/health.js'
import { createJobsRouter } from './routes/jobs.js'
import { BackgroundJobSystem } from './jobs/system.js'
import { authRouter } from './routes/auth.js'
import { analyticsRouter } from './routes/analytics.js'
import { apiKeysRouter } from './routes/apiKeys.js'
import { transactionsRouter } from './routes/transactions.js'
import { privacyRouter } from './routes/privacy.js'
import { adminRouter } from './routes/admin.js'
import { adminVerifiersRouter } from './routes/adminVerifiers.js'
import { verificationsRouter } from './routes/verifications.js'
import { milestonesRouter } from './routes/milestones.js'
import { orgVaultsRouter } from './routes/orgVaults.js'
import { orgAnalyticsRouter } from './routes/orgAnalytics.js'
import { startExpirationChecker } from './services/expirationScheduler.js'
import { healthRateLimiter, vaultsRateLimiter } from './middleware/rateLimiter.js'
import {
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} from './security/abuse-monitor.js'
import { initializeDatabase } from './db/database.js'

const PORT = process.env.PORT ?? 3000
const jobSystem = new BackgroundJobSystem()

jobSystem.start()
initializeDatabase()

app.use(securityMetricsMiddleware)
app.use(securityRateLimitMiddleware)

app.use('/api/health', healthRateLimiter, createHealthRouter(jobSystem))
app.use('/api/jobs', createJobsRouter(jobSystem))
app.use('/api/auth', authRouter)
app.use('/api/vaults', vaultsRateLimiter, vaultsRouter)
app.use('/api/vaults/:vaultId/milestones', milestonesRouter)
app.use('/api/transactions', transactionsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/api-keys', apiKeysRouter)
app.use('/api/privacy', privacyRouter)
app.use('/api/organizations', orgVaultsRouter)
app.use('/api/organizations', orgAnalyticsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/admin/verifiers', adminVerifiersRouter)
app.use('/api/verifications', verificationsRouter)

const server = app.listen(PORT, () => {
  console.log(`Disciplr API listening on http://localhost:${PORT}`)
  startExpirationChecker()
})

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}. Shutting down gracefully...`)
  try {
    await jobSystem.stop()
    server.close(() => {
      console.log('HTTP server closed.')
      process.exit(0)
    })
  } catch (error) {
    console.error('Error during shutdown:', error)
    process.exit(1)
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

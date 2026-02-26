import { app } from './app.js'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { vaultsRouter } from './routes/vaults.js'
import { createHealthRouter } from './routes/health.js'
import { createJobsRouter } from './routes/jobs.js'
import { BackgroundJobSystem } from './jobs/system.js'
import { vaultsRouter, Vault } from './routes/vaults.js'
import { authRouter } from './routes/auth.js'
import { analyticsRouter } from './routes/analytics.js'
import { healthRouter } from './routes/health.js'
import { healthRateLimiter, vaultsRateLimiter } from './middleware/rateLimiter.js'
import { createExportRouter } from './routes/exports.js'
import { transactionsRouter } from './routes/transactions.js'
import { privacyRouter } from './routes/privacy.js'
import { orgVaultsRouter } from './routes/orgVaults.js'
import { orgAnalyticsRouter } from './routes/orgAnalytics.js'
import { privacyLogger } from './middleware/privacy-logger.js'
import { adminRouter } from './routes/admin.js'
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

app.use(helmet())
app.use(
  cors({
    origin: '*', // Adjust this to specific origins for better security
  }),
)
app.use(express.json())
app.use(securityMetricsMiddleware)
app.use(securityRateLimitMiddleware)
app.use(privacyLogger)

app.use('/api/health', createHealthRouter(jobSystem))
app.use('/api/jobs', createJobsRouter(jobSystem))
app.use('/api/vaults', vaultsRouter)
app.use('/api/health', healthRateLimiter, healthRouter)
app.use('/api/vaults', vaultsRateLimiter, vaultsRouter)
app.use('/api/auth', authRouter)
app.use('/api/exports', createExportRouter(Vault))
app.use('/api/transactions', transactionsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/privacy', privacyRouter)
app.use('/api/organizations', orgVaultsRouter)
app.use('/api/organizations', orgAnalyticsRouter)
app.use('/api/admin', adminRouter)

const server = app.listen(PORT, () => {
  console.log(`Disciplr API listening on http://localhost:${PORT}`)
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

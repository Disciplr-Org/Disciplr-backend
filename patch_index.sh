#!/bin/bash
cat << 'INNER_EOF' > src/index.ts
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { app } from './app.js'
import { config } from './config/index.js'
import { vaultsRouter, vaults } from './routes/vaults.js'
import { authRouter } from './routes/auth.js'
import { healthRouter } from './routes/health.js'
import { healthRateLimiter, vaultsRateLimiter } from './middleware/rateLimiter.js'
import { createExportRouter } from './routes/exports.js'
import { transactionsRouter } from './routes/transactions.js'
import { analyticsRouter } from './routes/analytics.js'
import { privacyRouter } from './routes/privacy.js'
import { privacyLogger } from './middleware/privacy-logger.js'
import { adminRouter } from './routes/admin.js'
import { notFound } from './middleware/notFound.js'
import { errorHandler } from './middleware/errorHandler.js'
import {
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} from './security/abuse-monitor.js'

const PORT = process.env.PORT ?? config.port ?? 3000

app.use(helmet())
app.use(
  cors({
    origin: config.corsOrigins === '*' ? true : config.corsOrigins,
  }),
)
app.use(express.json())
app.use(securityMetricsMiddleware)
app.use(securityRateLimitMiddleware)
app.use(privacyLogger)

app.use('/api/health', healthRateLimiter, healthRouter)
app.use('/api/vaults', vaultsRateLimiter, vaultsRouter)
app.use('/api/auth', authRouter)
app.use('/api/exports', createExportRouter(vaults))
app.use('/api/transactions', transactionsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/privacy', privacyRouter)
app.use('/api/admin', adminRouter)

app.use(notFound)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`Disciplr API listening on http://localhost:${PORT}`)
})
INNER_EOF
chmod +x patch_index.sh
./patch_index.sh

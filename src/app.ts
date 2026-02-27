import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { analyticsRouter } from './routes/analytics.js'
import { apiKeysRouter } from './routes/apiKeys.js'
import { healthRouter } from './routes/health.js'
import { vaultsRouter } from './routes/vaults.js'
import { metricsRouter } from './routes/metrics.js'
import { metricsMiddleware } from './middleware/metrics.js'
import { healthRateLimiter, vaultsRateLimiter } from './middleware/rateLimiter.js'

export const app = express()

app.use(helmet())
app.use(cors({ origin: true }))
app.use(express.json())
app.use(metricsMiddleware)

app.use('/api/health', healthRateLimiter, healthRouter)
app.use('/api/vaults', vaultsRateLimiter, vaultsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/api-keys', apiKeysRouter)
app.use('/metrics', metricsRouter)

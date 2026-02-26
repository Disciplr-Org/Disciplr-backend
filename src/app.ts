import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { analyticsRouter } from './routes/analytics.js'
import { authRouter } from './routes/auth.js'
import { adminRouter } from './routes/admin.js'
import { apiKeysRouter } from './routes/apiKeys.js'
import { healthRouter } from './routes/health.js'
import { privacyRouter } from './routes/privacy.js'
import { transactionsRouter } from './routes/transactions.js'
import { verificationsRouter } from './routes/verifications.js'
import { vaultsRouter } from './routes/vaults.js'
import { privacyLogger } from './middleware/privacy-logger.js'
import {
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} from './security/abuse-monitor.js'

export const app = express()

app.use(helmet())
app.use(cors({ origin: true }))
app.use(express.json())
app.use(securityMetricsMiddleware)
app.use(securityRateLimitMiddleware)
app.use(privacyLogger)

app.use('/api/health', healthRouter)
app.use('/api/auth', authRouter)
app.use('/api/vaults', vaultsRouter)
app.use('/api/transactions', transactionsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/api-keys', apiKeysRouter)
app.use('/api/privacy', privacyRouter)
app.use('/api/verifications', verificationsRouter)
app.use('/api/admin', adminRouter)

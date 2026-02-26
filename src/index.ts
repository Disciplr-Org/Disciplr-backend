import { app } from './app.js'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { vaultsRouter } from './routes/vaults.js'
import { healthRouter } from './routes/health.js'
import { transactionsRouter } from './routes/transactions.js'
import { analyticsRouter } from './routes/analytics.js'
import { privacyRouter } from './routes/privacy.js'
import { privacyLogger } from './middleware/privacy-logger.js'
import { authRouter } from './routes/auth.js'
import { adminRouter } from './routes/admin.js'
import {
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} from './security/abuse-monitor.js'

const PORT = process.env.PORT ?? 3000

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
app.use('/api/privacy', privacyRouter)
app.use('/api/admin', adminRouter)

app.listen(PORT, () => {
  console.log(`Disciplr API listening on http://localhost:${PORT}`)
})

import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { authRouter } from './routes/auth.js'
import { adminRouter } from './routes/admin.js'
import { analyticsRouter } from './routes/analytics.js'
import { apiKeysRouter } from './routes/apiKeys.js'
import { healthRouter } from './routes/health.js'
import { vaultsRouter } from './routes/vaults.js'
import { notificationsRouter } from './routes/notifications.js'
import { transactionsRouter } from './routes/transactions.js'
import { privacyRouter } from './routes/privacy.js'
import { privacyLogger } from './middleware/privacy-logger.js'

export const app = express()

app.use(helmet())
app.use(cors({ origin: true }))
app.use(express.json())
app.use(privacyLogger)

app.use('/api/health', healthRouter)
app.use('/api/vaults', vaultsRouter)
app.use('/api/transactions', transactionsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/api-keys', apiKeysRouter)
app.use('/api/auth', authRouter)
app.use('/api/admin', adminRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/privacy', privacyRouter)

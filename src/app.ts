import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { analyticsRouter } from './routes/analytics.js'
import { apiKeysRouter } from './routes/apiKeys.js'
import { healthRouter } from './routes/health.js'
import { vaultsRouter } from './routes/vaults.js'

export const app = express()

app.use(helmet())
app.use(cors({ origin: true }))
app.use(express.json())

app.use('/api/health', healthRouter)
app.use('/api/vaults', vaultsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/api-keys', apiKeysRouter)

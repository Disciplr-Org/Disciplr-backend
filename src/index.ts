import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { vaultsRouter } from './routes/vaults.js'
import { healthRouter } from './routes/health.js'
import { transactionsRouter } from './routes/transactions.js'
import { ETLManager } from './services/etlManager.js'

// Load environment variables
dotenv.config()

const app = express()
const PORT = process.env.PORT ?? 3000

app.use(helmet())
app.use(cors({ origin: true }))
app.use(express.json())

app.use('/api/health', healthRouter)
app.use('/api/vaults', vaultsRouter)
app.use('/api/transactions', transactionsRouter)

app.listen(PORT, async () => {
  console.log(`Disciplr API listening on http://localhost:${PORT}`)
  
  // Initialize ETL service
  try {
    await ETLManager.getInstance().initialize()
    console.log('ETL service started successfully')
  } catch (error) {
    console.error('Failed to start ETL service:', error)
  }
})

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...')
  try {
    await ETLManager.getInstance().shutdown()
    process.exit(0)
  } catch (error) {
    console.error('Error during shutdown:', error)
    process.exit(1)
  }
})

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...')
  try {
    await ETLManager.getInstance().shutdown()
    process.exit(0)
  } catch (error) {
    console.error('Error during shutdown:', error)
    process.exit(1)
  }
})

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { vaultsRouter } from './routes/vaults.js'
import { createHealthRouter } from './routes/health.js'
import { createJobsRouter } from './routes/jobs.js'
import { BackgroundJobSystem } from './jobs/system.js'

const app = express()
const PORT = process.env.PORT ?? 3000
const jobSystem = new BackgroundJobSystem()

jobSystem.start()

app.use(helmet())
app.use(cors({ origin: true }))
app.use(express.json())

app.use('/api/health', createHealthRouter(jobSystem))
app.use('/api/jobs', createJobsRouter(jobSystem))
app.use('/api/vaults', vaultsRouter)

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

import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { privacyLogger } from './middleware/privacy-logger.js'

export const app = express()

app.use(helmet())

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000']
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'idempotency-key'],
  credentials: true,
}

app.use(cors(corsOptions))
app.use(express.json())

app.use((_req, res, next) => {
  res.setHeader('X-Timezone', 'UTC')
  next()
})

app.use(privacyLogger)

// Routes are mounted in index.ts

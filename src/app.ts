import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { analyticsRouter } from './routes/analytics.js'
import { apiKeysRouter } from './routes/apiKeys.js'
import { healthRouter } from './routes/health.js'
import { vaultsRouter } from './routes/vaults.js'
import { orgVaultsRouter } from './routes/orgVaults.js'
import { orgAnalyticsRouter } from './routes/orgAnalytics.js'
import { verificationsRouter } from './routes/verifications.js'
import { adminVerifiersRouter } from './routes/adminVerifiers.js'
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { vaultsRouter } from './routes/vaults.js';
import { healthRouter } from './routes/health.js';
import { analyticsRouter } from './routes/analytics.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { transactionsRouter } from './routes/transactions.js';
import { privacyRouter } from './routes/privacy.js';
import { privacyLogger } from './middleware/privacy-logger.js';

export const app = express();

app.use(helmet())
app.use(cors({ origin: true }))
app.use(express.json())
app.use((_req, res, next) => {
  res.setHeader('X-Timezone', 'UTC')
  next()
})
app.use(helmet());

app.use('/api/health', healthRouter)
app.use('/api/vaults', vaultsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/api-keys', apiKeysRouter)
app.use('/api/organizations', orgVaultsRouter)
app.use('/api/organizations', orgAnalyticsRouter)
app.use('/api/verifications', verificationsRouter)
app.use('/api/admin/verifiers', adminVerifiersRouter)
// 2. CORS: Origin validation
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(privacyLogger);

// Routes
app.use('/api/health', healthRouter);
app.use('/api/vaults', vaultsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/privacy', privacyRouter);

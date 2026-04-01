import { z } from 'zod'

/**
 * Coerces a string env var to a positive integer, returning the default
 * if the raw value is missing or not a valid positive number.
 */
const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback
      const n = Number.parseInt(v, 10)
      return Number.isFinite(n) && n > 0 ? n : fallback
    })

/**
 * Coerces a string env var to a non-negative integer.
 */
const nonNegativeInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback
      const n = Number.parseInt(v, 10)
      return Number.isFinite(n) && n >= 0 ? n : fallback
    })

/**
 * Schema for all environment variables consumed by the application.
 *
 * Required variables have no default and will cause a startup failure when
 * missing.  Optional variables carry sensible defaults so that local
 * development works without a .env file beyond DATABASE_URL.
 */
export const envSchema = z.object({
  // ── Core ────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: positiveInt(3000),
  SERVICE_NAME: z.string().default('disciplr-backend'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ── CORS ────────────────────────────────────────────────────────────
  CORS_ORIGINS: z.string().optional(),

  // ── Auth / secrets ──────────────────────────────────────────────────
  JWT_SECRET: z.string().default('change-me-in-production'),
  JWT_ACCESS_SECRET: z.string().default('fallback-access-secret'),
  JWT_REFRESH_SECRET: z.string().default('fallback-refresh-secret'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  DOWNLOAD_SECRET: z.string().default('change-me-in-production'),

  // ── Horizon / Stellar ───────────────────────────────────────────────
  HORIZON_URL: z.string().optional(),
  CONTRACT_ADDRESS: z.string().optional(),
  START_LEDGER: nonNegativeInt(0).optional(),
  RETRY_MAX_ATTEMPTS: nonNegativeInt(3),
  RETRY_BACKOFF_MS: nonNegativeInt(100),

  // ── Soroban ─────────────────────────────────────────────────────────
  SOROBAN_CONTRACT_ID: z.string().optional(),
  SOROBAN_NETWORK_PASSPHRASE: z.string().optional(),
  SOROBAN_SOURCE_ACCOUNT: z.string().optional(),
  STELLAR_NETWORK_PASSPHRASE: z.string().optional(),

  // ── Job system ──────────────────────────────────────────────────────
  JOB_WORKER_CONCURRENCY: positiveInt(2),
  JOB_QUEUE_POLL_INTERVAL_MS: positiveInt(250),
  JOB_HISTORY_LIMIT: positiveInt(50),
  ENABLE_JOB_SCHEDULER: z.string().optional(),

  // ── ETL ─────────────────────────────────────────────────────────────
  ETL_INTERVAL_MINUTES: positiveInt(5),
  ENABLE_ETL_WORKER: z.string().optional(),
  ETL_BACKFILL_FROM: z.string().optional(),
  ETL_BACKFILL_TO: z.string().optional(),

  // ── Security thresholds ─────────────────────────────────────────────
  SECURITY_RATE_LIMIT_WINDOW_MS: positiveInt(60_000),
  SECURITY_RATE_LIMIT_MAX_REQUESTS: positiveInt(120),
  SECURITY_SUSPICIOUS_WINDOW_MS: positiveInt(300_000),
  SECURITY_SUSPICIOUS_404_THRESHOLD: positiveInt(20),
  SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD: positiveInt(12),
  SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD: positiveInt(30),
  SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD: positiveInt(300),
  SECURITY_FAILED_LOGIN_WINDOW_MS: positiveInt(900_000),
  SECURITY_FAILED_LOGIN_BURST_THRESHOLD: positiveInt(5),
  SECURITY_ALERT_COOLDOWN_MS: positiveInt(300_000),

  // ── Deadline / Analytics schedulers ─────────────────────────────────
  DEADLINE_CHECK_INTERVAL_MS: positiveInt(60_000),
  ANALYTICS_RECOMPUTE_INTERVAL_MS: positiveInt(300_000),
})

export type Env = z.infer<typeof envSchema>

/** Warnings emitted during validation (not hard failures). */
export type EnvWarning = { variable: string; message: string }

/**
 * Validate `process.env` against the schema.  On success the typed,
 * transformed env object is returned together with any non-fatal warnings.
 * On failure the process prints structured errors and exits with code 1
 * (fail-fast).
 *
 * @param env  Defaults to `process.env` — pass a custom record in tests.
 */
export function validateEnv(
  env: Record<string, string | undefined> = process.env,
): { env: Env; warnings: EnvWarning[] } {
  const result = envSchema.safeParse(env)

  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.join('.')
      return `  - ${path}: ${i.message}`
    })

    console.error(
      JSON.stringify({
        level: 'fatal',
        event: 'config.env_validation_failed',
        service: 'disciplr-backend',
        message: 'Environment validation failed — aborting startup',
        errors: issues,
        timestamp: new Date().toISOString(),
      }),
    )
    process.exit(1)
  }

  const validated = result.data
  const warnings: EnvWarning[] = []

  // In production, insecure secret defaults are a misconfiguration worth
  // surfacing loudly — but they don't warrant a hard crash because the app
  // can technically still start.
  if (validated.NODE_ENV === 'production') {
    const insecureDefaults: Array<{ key: keyof Env; sentinel: string }> = [
      { key: 'JWT_SECRET', sentinel: 'change-me-in-production' },
      { key: 'JWT_ACCESS_SECRET', sentinel: 'fallback-access-secret' },
      { key: 'JWT_REFRESH_SECRET', sentinel: 'fallback-refresh-secret' },
      { key: 'DOWNLOAD_SECRET', sentinel: 'change-me-in-production' },
    ]

    for (const { key, sentinel } of insecureDefaults) {
      if (validated[key] === sentinel) {
        const w: EnvWarning = {
          variable: key,
          message: `${key} is using its insecure default value`,
        }
        warnings.push(w)
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'config.insecure_default',
            service: 'disciplr-backend',
            variable: key,
            message: w.message,
            timestamp: new Date().toISOString(),
          }),
        )
      }
    }
  }

  return { env: validated, warnings }
}

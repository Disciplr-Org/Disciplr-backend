import { z } from "zod";

/**
 * Coerces a string env var to a positive integer, returning the default
 * if the raw value is missing or not a valid positive number.
 */
const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return fallback;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    });

/** Coerces a string env var to a non-negative integer. */
const nonNegativeInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return fallback;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    });

/** Validates that a string is a valid http:// or https:// URL. */
const httpUrl = () =>
  z
    .string()
    .refine(
      (url) => /^https?:\/\/./.test(url),
      "must be a valid HTTP or HTTPS URL (e.g., https://example.com)",
    );

/** Schema for all environment variables consumed by the application. */
export const envSchema = z
  .object({
    // ── Core ────────────────────────────────────────────────────
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT: positiveInt(3000),
    SERVICE_NAME: z.string().default("disciplr-backend"),
    DATABASE_URL: z
      .string()
      .min(1, "DATABASE_URL is required")
      .refine(
        (url) =>
          url.startsWith("postgres://") || url.startsWith("postgresql://"),
        "DATABASE_URL must be a valid PostgreSQL connection URL",
      ),
    REDIS_URL: z
      .string()
      .optional()
      .refine(
        (url) => !url || url.startsWith("redis://") || url.startsWith("rediss://"),
        "REDIS_URL must be a valid Redis connection URL (starting with redis:// or rediss://)",
      ),

    // ── Auth / secrets ──────────────────────────────────────
    JWT_SECRET: z
      .string()
      .min(16, "must be at least 16 characters")
      .default("change-me-in-production-long-secret"),
    JWT_ACCESS_SECRET: z
      .string()
      .min(16, "must be at least 16 characters")
      .default("fallback-access-secret"),
    JWT_REFRESH_SECRET: z
      .string()
      .min(16, "must be at least 16 characters")
      .default("fallback-refresh-secret"),
    JWT_ACCESS_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smhd]$/, "invalid duration format")
      .default("15m"),
    JWT_REFRESH_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smhd]$/, "invalid duration format")
      .default("7d"),
    DOWNLOAD_SECRET: z
      .string()
      .min(16, "must be at least 16 characters")
      .default("change-me-in-production-long-secret"),

    // JWT key rotation support – JSON encoded array of {kid, secret, retiredAt?}
    JWT_KEYS: z
      .string()
      .optional()
      .transform((val) => {
        if (!val) return [];
        try {
          const parsed = JSON.parse(val);
          if (!Array.isArray(parsed))
            throw new Error("JWT_KEYS must be an array");
          return parsed.map((item: any) => {
            const ret = item.retiredAt ? new Date(item.retiredAt) : undefined;
            return { kid: item.kid, secret: item.secret, retiredAt: ret };
          });
        } catch (e) {
          throw new Error(`Invalid JWT_KEYS JSON: ${(e as Error).message}`);
        }
      }),

    // ── Horizon / Stellar ─────────────────────────────────────
    HORIZON_URL: z
      .string()
      .optional()
      .refine(
        (url) =>
          !url || url.startsWith("http://") || url.startsWith("https://"),
        "HORIZON_URL must be a valid HTTP or HTTPS URL",
      ),
    CORS_ORIGINS: z
      .string()
      .optional()
      .refine((val) => {
        if (val === undefined) return true;
        if (val === "") return false;
        if (val === "*") return true;
        const parts = val.split(",");
        return (
          parts.length > 0 && parts.every((p) => p.trim().startsWith("http"))
        );
      }, "CORS_ORIGINS cannot be empty"),
    CONTRACT_ADDRESS: z.string().optional(),
    START_LEDGER: nonNegativeInt(0).optional(),
    RETRY_MAX_ATTEMPTS: nonNegativeInt(3),
    RETRY_BACKOFF_MS: nonNegativeInt(100),

    // ── Soroban ────────────────────────────────────────────────
    SOROBAN_CONTRACT_ID: z
      .string()
      .optional()
      .refine(
        (v) => !v || /^C[0-9A-Z]{55}$/.test(v),
        "must be a valid Soroban contract ID (56-char base32 starting with C)",
      ),
    SOROBAN_NETWORK_PASSPHRASE: z.string().optional(),
    SOROBAN_SOURCE_ACCOUNT: z.string().optional(),
    SOROBAN_RPC_URL: httpUrl().optional(),
    SOROBAN_RPC_URLS: z.string().optional(),
    SOROBAN_SECRET_KEY: z.string().optional(),
    SOROBAN_SUBMIT_POLL_INTERVAL_MS: positiveInt(1_000),
    SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS: positiveInt(30),
    SOROBAN_RPC_TIMEOUT_MS: positiveInt(30_000),
    SOROBAN_SUBMIT_RETRY_MAX_BACKOFF_MS: positiveInt(5_000),
    SOROBAN_SUBMIT_TIMEOUT_MS: positiveInt(60_000),
    STELLAR_NETWORK_PASSPHRASE: z.string().optional(),

    // ── Job system ───────────────────────────────────────────────
    JOB_WORKER_CONCURRENCY: positiveInt(2),
    JOB_QUEUE_POLL_INTERVAL_MS: positiveInt(250),
    JOB_HISTORY_LIMIT: positiveInt(50),
    ENABLE_JOB_SCHEDULER: z.string().optional(),
    NOTIFICATION_PROVIDER: z.enum(["email", "console"]).default("console"),

    // ── ETL ───────────────────────────────────────────────────────
    ETL_INTERVAL_MINUTES: positiveInt(5),
    ENABLE_ETL_WORKER: z.string().optional(),
    ETL_BACKFILL_FROM: z.string().optional(),
    ETL_BACKFILL_TO: z.string().optional(),

    // ── Metrics / Prometheus scraper access ────────────────
    METRICS_TOKEN: z.string().optional(),
    METRICS_ALLOWLIST: z.string().optional(),

    // ── Security thresholds ───────────────────────────────────
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
    ORG_RATE_LIMIT_MAX: positiveInt(200),
    ORG_RATE_LIMIT_WINDOW_MS: positiveInt(60000),
    EXPORT_DAILY_QUOTA_LIMIT: positiveInt(100),

    // ── Deadline / Analytics schedulers ───────────────────────
    DEADLINE_CHECK_INTERVAL_MS: positiveInt(60_000),
    ANALYTICS_RECOMPUTE_INTERVAL_MS: positiveInt(300_000),

    // ── Misc / Limits ───────────────────────────────────────
    MAX_JSON_BODY_SIZE: z.string().default("500kb"),
    NOTIFICATION_PROVIDER: z.string().optional(),
    HORIZON_LAG_THRESHOLD: nonNegativeInt(10),
    HORIZON_SHUTDOWN_TIMEOUT_MS: positiveInt(30_000),

    // ── Webhooks ────────────────────────────────────────────
    WEBHOOK_INBOUND_SECRET: z.string().optional(),
    WEBHOOK_INBOUND_SKEW_MS: positiveInt(300_000),
    WEBHOOK_CIRCUIT_BREAKER_THRESHOLD: positiveInt(5),
    WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS: positiveInt(60_000),
    WEBHOOK_CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS: positiveInt(30_000),

    // ── Export S3 ───────────────────────────────────────────
    EXPORT_S3_BUCKET: z.string().optional(),
    EXPORT_S3_REGION: z.string().optional(),
    EXPORT_SIGNED_URL_TTL_S: positiveInt(3600),

    // ── HTTP Server Timeouts ─────────────────────────────────
    // Protects against slow-loris attacks and load balancer connection drops.
    // Defaults (in ms):
    //   - keepAliveTimeout: 45,000 (45s, must be < headersTimeout)
    //   - headersTimeout: 61,000 (61s, Node.js server-level timeout)
    //   - requestTimeout: 120,000 (120s, full request lifecycle)
    // Rationale:
    //   - keepAliveTimeout < headersTimeout prevents keep-alive sockets from
    //     lingering past when the server would timeout the headers.
    //   - headersTimeout slightly > 60s accommodates ALB idle timeout defaults.
    //   - requestTimeout allows slower uploads/downloads but remains bounded.
    HTTP_KEEPALIVE_TIMEOUT_MS: positiveInt(45_000),
    HTTP_HEADERS_TIMEOUT_MS: positiveInt(61_000),
    HTTP_REQUEST_TIMEOUT_MS: positiveInt(120_000),

    // ── Admin / Debug ──────────────────────────────────────────────
    ADMIN_API_KEY: z.string().default(""),

    // ── Log sampling ───────────────────────────────────────────────
    LOG_SAMPLE_RATE: z
      .string()
      .default("1")
      .transform((v) => {
        const n = Number.parseFloat(v);
        return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
      }),
    LOG_SLOW_THRESHOLD_MS: positiveInt(1000),
    LOG_ALWAYS_LOG_STATUS: z.string().default("500,502,503"),
  })
  .superRefine((data, ctx) => {
    // Existing CORS warning
    if (data.NODE_ENV === "production" && data.CORS_ORIGINS === "*") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGINS"],
        message: 'CORS_ORIGINS cannot be "*" in production environment',
      });
    }

    // ─ Validate HTTP timeout ordering ─
    if (data.HTTP_KEEPALIVE_TIMEOUT_MS >= data.HTTP_HEADERS_TIMEOUT_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["HTTP_KEEPALIVE_TIMEOUT_MS"],
        message: `HTTP_KEEPALIVE_TIMEOUT_MS (${data.HTTP_KEEPALIVE_TIMEOUT_MS}ms) must be less than HTTP_HEADERS_TIMEOUT_MS (${data.HTTP_HEADERS_TIMEOUT_MS}ms)`,
      });
    }

    if (data.HTTP_HEADERS_TIMEOUT_MS >= data.HTTP_REQUEST_TIMEOUT_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["HTTP_HEADERS_TIMEOUT_MS"],
        message: `HTTP_HEADERS_TIMEOUT_MS (${data.HTTP_HEADERS_TIMEOUT_MS}ms) must be less than HTTP_REQUEST_TIMEOUT_MS (${data.HTTP_REQUEST_TIMEOUT_MS}ms)`,
      });
    }

    // Additional validation for JWT_KEYS could be added here if needed
  });

export type Env = z.infer<typeof envSchema>;
export type JwtKey = { kid: string; secret: string; retiredAt?: Date };
export type EnvWarning = { field: string; message: string };

let _validated: Env | undefined;

/**
 * Return the validated env, throwing if `initEnv()` has not been called.
 */
export function getEnv(): Env {
  if (!_validated) {
    throw new Error("Environment not validated yet — call initEnv() first");
  }
  return _validated;
}

/** Reset internal state — exposed for tests only. */
export function _resetEnvForTesting(): void {
  _validated = undefined;
}

/**
 * Validate `process.env` against the schema.  On success the typed,
 * transformed env object is returned together with any non-fatal warnings.
 * On failure the process prints structured errors and exits with code 1
 * (fail-fast).
 *
 * Sensitive values are never included in error output — only field names
 * and validation messages are logged.
 *
 * @param env  Defaults to `process.env` — pass a custom record in tests.
 */
export function initEnv(
  env: Record<string, string | undefined> = process.env,
): { env: Env; warnings: EnvWarning[] } {
  if (_validated) return { env: _validated, warnings: [] };

  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.join(".");
      return `  - ${path}: ${i.message}`;
    });

    console.error(
      JSON.stringify({
        level: "fatal",
        event: "config.env_validation_failed",
        service: "disciplr-backend",
        message: "Environment validation failed — aborting startup",
        errors: issues,
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  }

  const validated = result.data;
  _validated = validated;
  const warnings: EnvWarning[] = [];

  // In production, insecure secret defaults are a misconfiguration worth
  // surfacing loudly — but they don't warrant a hard crash because the app
  // can technically still start.
  if (validated.NODE_ENV === "production") {
    const insecureDefaults: Array<{ key: keyof Env; sentinel: string }> = [
      { key: "JWT_SECRET", sentinel: "change-me-in-production-long-secret" },
      { key: "JWT_ACCESS_SECRET", sentinel: "fallback-access-secret-long" },
      { key: "JWT_REFRESH_SECRET", sentinel: "fallback-refresh-secret-long" },
      {
        key: "DOWNLOAD_SECRET",
        sentinel: "change-me-in-production-long-secret",
      },
    ];

    for (const { key, sentinel } of insecureDefaults) {
      if (validated[key] === sentinel) {
        const w: EnvWarning = {
          variable: key,
          message: `${key} is using its insecure default value`,
        };
        warnings.push(w);
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "config.insecure_default",
            service: "disciplr-backend",
            variable: key,
            message: w.message,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  // Detect partially configured Soroban environment variables.
  const sorobanVars = [
    "SOROBAN_CONTRACT_ID",
    "SOROBAN_NETWORK_PASSPHRASE",
    "SOROBAN_SOURCE_ACCOUNT",
    "SOROBAN_RPC_URL",
    "SOROBAN_SECRET_KEY",
  ];
  const present = sorobanVars.filter(
    (key) =>
      validated[key as keyof Env] !== undefined &&
      validated[key as keyof Env] !== "",
  );
  if (present.length > 0 && present.length < sorobanVars.length) {
    const w: EnvWarning = {
      variable: "SOROBAN_*",
      message:
        "Partial Soroban configuration detected; submit mode will be disabled",
    };
    warnings.push(w);
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "config.partial_soroban_configuration",
        service: "disciplr-backend",
        variable: "SOROBAN_*",
        message: w.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return { env: validated, warnings };
}

/**
 * Validates and parses environment variables.
 * Returns parsed env and any non-fatal warnings.
 * Throws on hard validation failures.
 */
export function validateEnv(raw?: Record<string, string | undefined>): {
  env: Env;
  warnings: EnvWarning[];
} {
  const input = raw ?? process.env;
  const result = envSchema.safeParse(input);

  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Environment validation failed: ${messages}`);
  }

  const warnings: EnvWarning[] = [];

  // Warn if Soroban vars are partially configured
  const sorobanVars = [
    "SOROBAN_CONTRACT_ID",
    "SOROBAN_NETWORK_PASSPHRASE",
    "SOROBAN_SOURCE_ACCOUNT",
    "SOROBAN_RPC_URL",
    "SOROBAN_SECRET_KEY",
  ] as const;
  const sorobanSet = sorobanVars.filter((k) => !!(result.data as any)[k]);
  if (sorobanSet.length > 0 && sorobanSet.length < sorobanVars.length) {
    warnings.push({
      field: "SOROBAN",
      message: `Soroban is partially configured (${sorobanSet.length}/${sorobanVars.length} vars set). Submit mode disabled.`,
    });
  }

  return { env: result.data, warnings };
}

/** Returns parsed JWT keys from the environment. */
export function getJwtKeys(env: Env): JwtKey[] {
  return (env as any).JWT_KEYS as JwtKey[];
}

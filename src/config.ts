import { z } from 'zod'

// ── Secret provider abstraction ──────────────────────────────────
export interface SecretProvider {
     get(key: string): string | undefined
}

export class EnvSecretProvider implements SecretProvider {
     get(key: string): string | undefined {
          return process.env[key]
     }
}

// ── Schema ───────────────────────────────────────────────────────
export const configSchema = z.object({
     port: z
          .coerce.number()
          .int()
          .min(1)
          .max(65535)
          .default(3000)
          .describe('HTTP server port'),

     jwtSecret: z
          .string()
          .min(16, 'JWT_SECRET must be at least 16 characters')
          .describe('Secret used to sign/verify JWTs'),

     databaseUrl: z
          .string()
          .url('DATABASE_URL must be a valid URL')
          .refine((u) => u.startsWith('postgres'), {
               message: 'DATABASE_URL must use a postgres:// scheme',
          })
          .describe('PostgreSQL connection string'),

     nodeEnv: z
          .enum(['development', 'production', 'test'])
          .default('development')
          .describe('Runtime environment'),
})

export type AppConfig = z.infer<typeof configSchema>

// ── Loader (testable) ────────────────────────────────────────────
export function parseConfig(provider: SecretProvider = new EnvSecretProvider()): AppConfig {
     const raw = {
          port: provider.get('PORT'),
          jwtSecret: provider.get('JWT_SECRET'),
          databaseUrl: provider.get('DATABASE_URL'),
          nodeEnv: provider.get('NODE_ENV'),
     }

     const result = configSchema.safeParse(raw)

     if (!result.success) {
          const messages = result.error.issues
               .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
               .join('\n')
          throw new Error(`Invalid configuration:\n${messages}`)
     }

     return result.data
}

// ── Loader (app entrypoint) ──────────────────────────────────────
function loadConfig(): AppConfig {
     try {
          return parseConfig()
     } catch (err) {
          console.error((err as Error).message)
          process.exit(1)
     }
}

// ── Singleton ────────────────────────────────────────────────────
export const config: AppConfig = Object.freeze(loadConfig())

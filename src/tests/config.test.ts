import { parseConfig, type SecretProvider } from '../config.js'

/** Helper: builds a SecretProvider from a plain object. */
function envFrom(vars: Record<string, string>): SecretProvider {
     return { get: (key: string) => vars[key] }
}

const VALID_ENV = {
     JWT_SECRET: 'a-secure-secret-at-least-16-chars',
     DATABASE_URL: 'postgres://localhost:5432/disciplr_test',
     PORT: '4000',
     NODE_ENV: 'production',
} as const

describe('parseConfig', () => {
     it('parses a complete valid env', () => {
          const cfg = parseConfig(envFrom(VALID_ENV))
          expect(cfg.port).toBe(4000)
          expect(cfg.jwtSecret).toBe(VALID_ENV.JWT_SECRET)
          expect(cfg.databaseUrl).toBe(VALID_ENV.DATABASE_URL)
          expect(cfg.nodeEnv).toBe('production')
     })

     it('applies defaults for PORT and NODE_ENV', () => {
          const cfg = parseConfig(envFrom({
               JWT_SECRET: VALID_ENV.JWT_SECRET,
               DATABASE_URL: VALID_ENV.DATABASE_URL,
          }))
          expect(cfg.port).toBe(3000)
          expect(cfg.nodeEnv).toBe('development')
     })

     it('coerces PORT from string to number', () => {
          const cfg = parseConfig(envFrom({
               ...VALID_ENV,
               PORT: '8080',
          }))
          expect(cfg.port).toBe(8080)
          expect(typeof cfg.port).toBe('number')
     })

     it('throws if JWT_SECRET is missing', () => {
          expect(() =>
               parseConfig(envFrom({
                    DATABASE_URL: VALID_ENV.DATABASE_URL,
               })),
          ).toThrow(/JWT_SECRET|jwtSecret/)
     })

     it('throws if JWT_SECRET is shorter than 16 characters', () => {
          expect(() =>
               parseConfig(envFrom({
                    ...VALID_ENV,
                    JWT_SECRET: 'short',
               })),
          ).toThrow(/at least 16/)
     })

     it('throws if DATABASE_URL is missing', () => {
          expect(() =>
               parseConfig(envFrom({
                    JWT_SECRET: VALID_ENV.JWT_SECRET,
               })),
          ).toThrow(/DATABASE_URL|databaseUrl/)
     })

     it('throws if DATABASE_URL does not use postgres scheme', () => {
          expect(() =>
               parseConfig(envFrom({
                    ...VALID_ENV,
                    DATABASE_URL: 'mysql://localhost:3306/db',
               })),
          ).toThrow(/postgres/)
     })

     it('throws if PORT is out of range', () => {
          expect(() =>
               parseConfig(envFrom({
                    ...VALID_ENV,
                    PORT: '99999',
               })),
          ).toThrow(/port|65535/i)
     })

     it('throws if NODE_ENV is an invalid value', () => {
          expect(() =>
               parseConfig(envFrom({
                    ...VALID_ENV,
                    NODE_ENV: 'staging',
               })),
          ).toThrow(/nodeEnv|NODE_ENV|Invalid/)
     })
})

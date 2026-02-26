import type { Config } from 'jest'

const config: Config = {
     preset: 'ts-jest/presets/default-esm',
     testEnvironment: 'node',
     setupFiles: ['./src/tests/setup-env.ts'],
     extensionsToTreatAsEsm: ['.ts'],
     moduleNameMapper: {
          '^(\\.{1,2}/.*)\\.js$': '$1',
     },
     transform: {
          '^.+\\.ts$': ['ts-jest', { useESM: true }],
     },
     testMatch: ['**/tests/**/*.test.ts'],
     clearMocks: true,
}

export default config
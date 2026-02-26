import type { Config } from 'jest'

const config: Config = {
     testEnvironment: 'node',
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
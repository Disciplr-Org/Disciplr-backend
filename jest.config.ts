import type { Config } from 'jest'

const config: Config = {
     testEnvironment: 'node',
     extensionsToTreatAsEsm: ['.ts'],
     moduleNameMapper: {
          '^(\\.{1,2}/.*)\\.js$': '$1',
     },
     transform: {
          '^.+\\.ts$': ['<rootDir>/node_modules/ts-jest', { useESM: true, diagnostics: { ignoreCodes: [151002] } }],
     },
     testMatch: ['**/tests/**/*.test.ts'],
     clearMocks: true,
}

export default config
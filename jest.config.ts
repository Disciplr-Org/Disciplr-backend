import type { Config } from 'jest'

const config: Config = {
     testEnvironment: 'node',
     extensionsToTreatAsEsm: ['.ts'],
     moduleNameMapper: {
          '^(\\.{1,2}/.*)\\.js$': '$1',
          '^@prisma/client$': '<rootDir>/src/tests/__mocks__/prisma-client.ts',
     },
     transform: {
        '^.+\\.ts$': ['<rootDir>/node_modules/ts-jest', {
            useESM: true,
            tsconfig: {
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                target: 'ES2022'
            },
            diagnostics: { ignoreCodes: [151002] }
        }],
     },
     testMatch: ['**/tests/**/*.test.ts'],
     clearMocks: true,
}

export default config

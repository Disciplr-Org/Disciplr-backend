/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@prisma/client$": "<rootDir>/src/tests/__mocks__/prisma.ts",
    // pnpm hoists mime@2.x but send@0.19.2 (Express) needs mime@1.x (charsets/lookup)
    // while superagent (supertest) needs mime@2.x (getType). Use a shim with both APIs.
    "^mime$": "<rootDir>/src/tests/__mocks__/mime.cjs",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.jest.json",
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  setupFiles: ["<rootDir>/jest.setup.cjs"],
  testMatch: ["**/tests/**/*.test.ts", "**/src/**/*.test.ts"],
  moduleDirectories: ["node_modules", "<rootDir>/node_modules"],
  clearMocks: true,
};

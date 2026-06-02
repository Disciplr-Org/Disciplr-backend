/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
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
  testMatch: ["**/tests/**/*.test.ts", "**/src/tests/**/*.test.ts"],
  moduleDirectories: ["node_modules", "<rootDir>/node_modules"],
  clearMocks: true,
};

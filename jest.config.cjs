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
        tsconfig: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
        },
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  testMatch: ["**/tests/**/*.test.ts", "**/src/tests/**/*.test.ts"],
  clearMocks: true,
};

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.ts$": [
      "@swc/jest",
      { jsc: { target: "es2022", parser: { syntax: "typescript" } }, module: { type: "commonjs" } },
    ],
  },
  globalSetup: "<rootDir>/tests/support/global-setup.ts",
  setupFiles: ["<rootDir>/tests/support/setup-env.ts"],
  // e2e suites share one Postgres DB + Valkey DB, so run files serially.
  maxWorkers: 1,
  testTimeout: 30_000,
  clearMocks: true,
};

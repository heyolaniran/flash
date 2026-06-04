// eslint-disable-next-line @typescript-eslint/no-var-requires
const swcConfig = require("../../swc-config.json")

// Dedicated config for Bridge-specific integration tests.
// These tests require a real MongoDB instance and are excluded from the default
// integration suite (jest.config.js) to keep CI fast.
//
// Run an individual suite:
//   node node_modules/.bin/jest --config test/flash/integration/jest.bridge.config.js \
//     --testPathPattern=transfer-webhook-e2e
//
// Run all bridge tests:
//   node node_modules/.bin/jest --config test/flash/integration/jest.bridge.config.js
//
// ENG-350 suites:
//   transfer-webhook-e2e   — transferHandler + MongoDB + notifications
//   transfer-replay-e2e    — replayHandler → transferHandler + BridgeReplay audit log

module.exports = {
  moduleFileExtensions: ["js", "json", "ts", "cjs", "mjs"],
  rootDir: "../../../",
  roots: ["<rootDir>/test/flash/integration/services/bridge"],
  transform: {
    "^.+\\.(t|j)sx?$": ["@swc/jest", swcConfig],
  },
  testRegex: ".*\\.spec\\.ts$",
  setupFilesAfterEnv: ["<rootDir>/test/flash/integration/jest.bridge.setup.ts"],
  testEnvironment: "node",
  moduleNameMapper: {
    "^@config$": ["<rootDir>src/config/index"],
    "^@app$": ["<rootDir>src/app/index"],
    "^@utils$": ["<rootDir>src/utils/index"],

    "^@core/(.*)$": ["<rootDir>src/core/$1"],
    "^@app/(.*)$": ["<rootDir>src/app/$1"],
    "^@domain/(.*)$": ["<rootDir>src/domain/$1"],
    "^@services/(.*)$": ["<rootDir>src/services/$1"],
    "^@servers/(.*)$": ["<rootDir>src/servers/$1"],
    "^@graphql/(.*)$": ["<rootDir>src/graphql/$1"],
    "^test/(.*)$": ["<rootDir>test/$1"],
  },
}

// Point the app's DATABASE_URL (read by src/db at import time) at the real
// test database when one is provided, so DB-backed suites and the services
// they exercise share a single connection target. jest.setup.cjs otherwise
// seeds a placeholder DATABASE_URL that does not resolve to a real server.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}

export {}

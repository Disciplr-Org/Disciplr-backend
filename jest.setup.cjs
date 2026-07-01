// Global Jest setup: runs before each test file, before the test framework is
// installed. Used to seed environment defaults required by modules under test.

// Field encryption requires a key to be configured. Provide a deterministic,
// non-secret 32-byte (base64) key for the test environment so repositories that
// encrypt/decrypt reversible secrets work without each suite wiring its own key.
// Individual suites may override FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEYS
// (e.g. to test rotation) and reset the cached env via _resetEnvForTesting().
if (!process.env.FIELD_ENCRYPTION_KEY && !process.env.FIELD_ENCRYPTION_KEYS) {
  // 32 zero bytes, base64-encoded — test-only, never use in production.
  process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 0).toString('base64')
}

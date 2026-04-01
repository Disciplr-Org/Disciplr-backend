# Implementation Plan: privacy-logger

## Overview

Rewrite `src/middleware/privacy-logger.ts` to export a pure `redact` utility and a structured-JSON Express middleware. Add a Jest test suite with snapshot, unit, and property-based tests using `fast-check`.

## Tasks

- [ ] 1. Install fast-check and update tsconfig/jest config if needed
  - Run `npm install --save-dev fast-check` and verify it resolves under the existing `ts-jest` + ESM setup
  - Confirm `jest.config` picks up `tests/middleware/**` (add glob if missing)
  - _Requirements: 6.1_

- [ ] 2. Rewrite `src/middleware/privacy-logger.ts`
  - [ ] 2.1 Define `SENSITIVE_KEYS` set and `PII_PATTERNS` array
    - Lowercase set: `password`, `passwordhash`, `token`, `accesstoken`, `refreshtoken`, `apikey`, `api_key`, `secret`, `authorization`, `x-api-key`, `x-auth-token`, `credential`, `credentials`, `ssn`, `creditcard`, `credit_card`, `cvv`, `pin`, `cookie`
    - Patterns: `EMAIL_RE`, `JWT_RE` as documented in design
    - _Requirements: 1.1, 1.3, 1.4, 4.2, 4.3, 4.4, 4.6_

  - [ ] 2.2 Implement and export `redact<T>(value: T): T`
    - Handle primitives, arrays, plain objects recursively
    - Case-insensitive key matching against `SENSITIVE_KEYS`
    - Value-pattern matching against `PII_PATTERNS`
    - Circular-reference safety (try/catch per value → `"[REDACTED]"`)
    - Must not mutate input
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 5.1, 5.2, 5.3, 5.4, 7.2_

  - [ ] 2.3 Implement and export `maskIp(ip: string): string`
    - IPv4 → `a.b.x.x`, IPv6 → first 3 groups + `:xxxx:xxxx:xxxx:xxxx:xxxx`, fallback → `"unknown"`
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 2.4 Implement `privacyLogger` Express middleware
    - Register `res.on('finish')` listener, then call `next()` immediately
    - On finish: build `LogLine` object using `redact` on body/query/headers and `maskIp` on IP
    - Set `body` to `null` when absent/non-object; set `query` to `null` when empty
    - Wrap `JSON.stringify(logLine)` in try/catch; emit fallback JSON on failure
    - Always call `next()` — do not re-call if already called
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 7.1, 7.3_

- [ ] 3. Create `tests/middleware/privacy-logger.test.ts`
  - [ ] 3.1 Write snapshot test for structured log line
    - Mock a request with `Authorization: Bearer eyJ...`, `x-api-key: sk-test`, body `{ email: "user@example.com", password: "secret123", name: "Alice" }`
    - Spy on `console.log`, fire middleware, parse emitted JSON, run `expect(logLine).toMatchSnapshot()`
    - Confirm `authorization`, `x-api-key`, `email`, `password` values are all `"[REDACTED]"` in snapshot
    - _Requirements: 6.1, 6.3_

  - [ ]* 3.2 Write property test — P1: sensitive keys redacted (including nested)
    - Use `fast-check` to generate random nested objects containing keys from `SENSITIVE_KEYS`
    - Assert every sensitive key's value in output equals `"[REDACTED]"` at all depths
    - Minimum 100 runs; tag: `// Feature: privacy-logger, Property 1`
    - _Requirements: 1.1, 1.2_

  - [ ]* 3.3 Write property test — P2: non-sensitive fields preserved
    - Generate random objects with only safe keys and safe values
    - Assert `redact(obj)` deep-equals `obj`
    - Tag: `// Feature: privacy-logger, Property 2`
    - _Requirements: 1.5_

  - [ ]* 3.4 Write property test — P3: immutability
    - Generate random objects, deep-clone before calling `redact`, assert original unchanged after call
    - Tag: `// Feature: privacy-logger, Property 3`
    - _Requirements: 1.6_

  - [ ]* 3.5 Write property test — P4: email-pattern values redacted
    - Generate random objects where arbitrary keys hold email-shaped strings
    - Assert all such values become `"[REDACTED]"` in output
    - Tag: `// Feature: privacy-logger, Property 4`
    - _Requirements: 1.3_

  - [ ]* 3.6 Write property test — P5: JWT-pattern values redacted
    - Generate random objects where arbitrary keys hold JWT-shaped strings (`x.y.z` base64url)
    - Assert all such values become `"[REDACTED]"` in output
    - Tag: `// Feature: privacy-logger, Property 5`
    - _Requirements: 1.4_

  - [ ]* 3.7 Write property test — P6: array elements recursively redacted
    - Generate random arrays of objects with sensitive keys
    - Assert `redact(arr)` returns a new array where every element is fully redacted
    - Tag: `// Feature: privacy-logger, Property 6`
    - _Requirements: 5.3_

  - [ ]* 3.8 Write property test — P7: log line has exactly the required keys
    - Generate random mock Express req/res pairs with varying methods, URLs, bodies, headers
    - Capture emitted JSON, parse it, assert `Object.keys(logLine).sort()` equals the required key set
    - Tag: `// Feature: privacy-logger, Property 7`
    - _Requirements: 2.2, 2.3_

  - [ ]* 3.9 Write property test — P8: IP masking
    - Generate random valid IPv4 strings; assert output matches `/^\d+\.\d+\.x\.x$/`
    - Generate random valid IPv6 strings; assert output has exactly 3 real groups + 5 `xxxx` groups
    - Tag: `// Feature: privacy-logger, Property 8`
    - _Requirements: 3.1, 3.2_

  - [ ]* 3.10 Write property test — P9: next() always called
    - Generate random requests including ones with circular bodies and missing fields
    - Assert `next` spy is called exactly once per middleware invocation
    - Tag: `// Feature: privacy-logger, Property 9`
    - _Requirements: 7.3_

  - [ ]* 3.11 Write unit tests for edge cases
    - No body → `body: null`; empty query → `query: null`; unknown IP → `"unknown"`
    - Circular body → serialization fallback log line emitted, `next()` still called
    - `redact` with primitive inputs (string, number, null) → returned unchanged
    - `redact` with email/JWT string at top level → returned as `"[REDACTED]"`
    - _Requirements: 2.4, 2.5, 3.3, 5.2, 7.1, 7.2_

- [ ] 4. Checkpoint — run `npm test` and confirm all tests pass with ≥ 95% coverage on `src/middleware/privacy-logger.ts`
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Wire up and validate in app
  - [ ] 5.1 Confirm `app.ts` already imports and registers `privacyLogger` (it does — verify no duplicate registration after rewrite)
    - Remove or demote `requestLogger` if it would double-log; keep it only for dev plain-text if desired
    - _Requirements: 2.1_

  - [ ]* 5.2 Write integration smoke test
    - Hit `GET /api/health` via supertest with an `Authorization` header
    - Assert `console.log` spy received a valid JSON string with `authorization: "[REDACTED]"` and all required keys present
    - _Requirements: 2.2, 4.2_

- [ ] 6. Final checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Snapshot file will be created at `tests/middleware/__snapshots__/privacy-logger.test.ts.snap` on first run; commit it
- To update the snapshot intentionally: `npx jest --updateSnapshot --testPathPattern privacy-logger`
- `fast-check` works with Jest ESM — ensure `transform` in jest config covers the package if needed

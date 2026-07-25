## IMPLEMENTATION PLAN

# Implementation Plan: Add RateLimit-* and Retry-After Headers

## Objective

Update `src/middleware/rateLimiter.ts` to emit standard IETF RateLimit draft-7 headers and a `Retry-After` header on 429 responses, allowing API clients and SDKs to implement deterministic backoff behavior without guessing rate-limit windows.

## Scope

### Middleware Changes

* Review existing `express-rate-limit` configuration in `src/middleware/rateLimiter.ts`.
* Enable standard rate-limit headers using:

  ```ts
  standardHeaders: 'draft-7'
  ```
* Verify legacy headers behavior and disable them if no longer required.
* Add `Retry-After` header generation for all rate-limited requests.
* Calculate retry duration from `req.rateLimit.resetTime`.
* Ensure header values are rounded to whole seconds and never return negative values.
* Preserve existing rate-limiting behavior and status codes.

### Error Handling Verification

* Review interaction with `src/middleware/errorHandler.ts`.
* Confirm custom 429 responses continue to flow correctly through the error pipeline.
* Ensure RateLimit and Retry-After headers are not removed or overwritten by downstream middleware.
* Validate compatibility with existing response formatting conventions.

### Test Coverage

Create `src/tests/rateLimitHeaders.test.ts`.

Test scenarios:

* Returns `RateLimit-Limit` header when rate limiting is configured.
* Returns remaining quota headers expected under draft-7 mode.
* Returns `Retry-After` header on 429 responses.
* Retry-After value matches calculated reset window.
* Header values are valid integers in seconds.
* No regression to existing rate-limiter behavior.
* Error handler integration preserves emitted headers.

Coverage target:

* ≥95% coverage for modified middleware paths.

### Documentation

Update `docs/operations.md` with:

* Description of emitted RateLimit headers.
* Retry-After behavior.
* Example 429 response.
* Guidance for API consumers and SDK implementations.
* Recommended client-side backoff strategy.

Example response:

HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 60
Retry-After: 60

### Validation

* Run full test suite.
* Verify no existing tests regress.
* Confirm headers appear in live middleware responses.
* Confirm Retry-After accurately reflects reset time calculations.

## Deliverables

* Updated `src/middleware/rateLimiter.ts`
* New `src/tests/rateLimitHeaders.test.ts`
* Updated `docs/operations.md`
* Verification notes for `errorHandler.ts` compatibility
* Test results attached to PR

## Expected Outcome

Clients receiving 429 responses can reliably determine when to retry requests using standards-compliant RateLimit headers and Retry-After values, improving SDK behavior and reducing unnecessary request traffic.

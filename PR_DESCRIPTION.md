## Summary

This PR hardens the shared query parsing middleware used by list endpoints against unsafe query input.

## What changed

- Added explicit validation to reject prototype-pollution style keys such as `__proto__`, `constructor`, and `prototype`.
- Rejected malformed or unsupported query parameters before they can be parsed into filter/sort/pagination state.
- Tightened pagination and sort parsing to fail fast on invalid numeric values or unsupported sort order values.
- Added regression tests covering rejection of unsafe query keys and acceptance of valid filters/sort/pagination input.

## Why

The previous middleware accepted a broad set of query keys and did not guard against polluted or malformed input. That made it possible for unexpected query parameters to influence request handling and could create edge cases in downstream filtering logic.

## Impact

- Improves resilience of list/search endpoints against malformed or hostile query payloads.
- Preserves existing supported behavior for valid pagination, filtering, and sorting.
- Adds regression coverage to prevent future regressions in the query parser contract.

## Testing

- Added targeted regression tests in `src/tests/queryParser.injection.test.ts`.
- Verified there are no TypeScript/editor errors in the touched files.
- Attempted to run the Jest regression suite, but local execution is currently blocked by the environment’s npm/Node setup.

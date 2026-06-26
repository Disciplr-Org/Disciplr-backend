# Tenant Isolation Threat Model

This document maps the main tenant-isolation leak vectors to the control files
and regression tests that currently cover each path.

## Isolation rules

- Tenant context comes from the authenticated route parameter or scoped request
  state, never from client-controlled body data.
- Scoped reads filter before sort, filter, and pagination logic runs.
- Cached decisions must include the tenant identity in the cache key.
- Outbound side effects must stay within the requesting org or user boundary.

## Control / test map

| Vector | Control files | Regression tests | Status |
| --- | --- | --- | --- |
| Route params and org-scoped REST | `src/routes/orgVaults.ts`, `src/routes/orgAnalytics.ts`, `src/routes/orgMembers.ts`, `src/middleware/orgAuth.ts` | `src/tests/orgVaultIsolation.test.ts`, `src/tests/orgVaults.test.ts`, `src/tests/orgInvitations.test.ts` | Covered |
| Query filters and pagination | `src/middleware/queryParser.ts`, `src/utils/pagination.ts` | `src/tests/orgVaultIsolation.test.ts` | Covered |
| GraphQL | `src/routes/graphql.ts` | `src/tests/graphql.read.test.ts` | Follow-up: add a cross-org isolation regression test |
| Exports | `src/routes/exports.ts`, `src/services/exportQueue.ts`, `src/services/exportS3.ts` | `src/routes/exports.test.ts`, `src/routes/exports.quota.test.ts`, `src/tests/exportQueue.s3.test.ts` | Covered |
| Webhooks | `src/routes/webhooks.ts`, `src/middleware/webhookVerify.ts`, `src/services/webhooks.ts` | `src/tests/webhooks.ssrf.test.ts`, `src/tests/webhooks.e2e.test.ts`, `src/tests/webhookVerify.test.ts` | Covered |
| Caches | `src/services/featureFlags.ts` | `src/tests/featureFlags.test.ts` | Covered |

## Follow-up

The only explicit gap in this map is GraphQL tenant isolation. The current
`src/tests/graphql.read.test.ts` file covers happy-path reads and the route
shape, but it does not yet assert that a request for one org cannot observe
data from another org.

If GraphQL grows broader read access later, add a same-org versus other-org
fixture and keep the `POST /api/organizations/:orgId/graphql` response
strictly org-bound.

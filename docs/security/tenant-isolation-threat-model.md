# Tenant Isolation Threat Model

This document maps tenant-leak vectors to the controls and tests that currently enforce isolation. It is scoped to organization-owned data paths and should be updated whenever a new org-scoped endpoint, cache, export, GraphQL resolver, or webhook path is added.

## Isolation Boundary

Tenant identity is the organization id. For org routes, it comes from `req.params.orgId` after authentication and membership checks. Handlers must not trust `orgId` supplied in query strings or request bodies for data access.

The primary contract remains:

1. Authenticate the caller.
2. Resolve the target org from the route or trusted request context.
3. Verify membership and required role.
4. Apply the org filter before user-controlled filters, sorting, pagination, batching, serialization, delivery, or caching.

## Vector Map

| Vector | Leak risk | Control files | Test files | Status |
|--------|-----------|---------------|------------|--------|
| Route params | A caller swaps `:orgId` to read another org's vaults, analytics, or members. | `src/middleware/orgAuth.ts`, `src/routes/orgVaults.ts`, `src/routes/orgAnalytics.ts`, `src/routes/orgMembers.ts` | `src/tests/orgVaultIsolation.test.ts`, `src/tests/orgVaults.test.ts`, `src/tests/orgInvitations.test.ts` | Covered for vaults, analytics, membership, invitations, fabricated orgs, and dual-membership users. |
| Query filters | A caller uses filters, sorting, or pagination to pull matching records from another org. | `src/routes/orgVaults.ts`, `src/middleware/queryParser.ts`, `src/utils/pagination.ts` | `src/tests/orgVaultIsolation.test.ts`, `src/tests/orgVaults.test.ts` | Covered for vault list filters, sorting, empty pages, and response-body audits. |
| GraphQL | A caller enters through `/api/organizations/:orgId/graphql` but resolvers return unscoped vaults or analytics. | `src/app-bootstrap.ts`, `src/routes/graphql.ts`, `src/middleware/orgAuth.ts` | `src/tests/graphql.read.test.ts` | Follow-up needed: route middleware and depth limits are tested, but resolver-level org filtering and cross-org GraphQL denial are not. |
| Exports | A caller exports another user's or org's data, polls another export job, or downloads another export result. | `src/routes/exports.ts`, `src/services/exportQueue.ts`, `src/services/exportQuota.ts`, `src/middleware/auth.ts` | `src/routes/exports.test.ts`, `src/routes/exports.quota.test.ts`, `src/tests/exportQueue.s3.test.ts`, `src/tests/exportQueue.pii.test.ts` | Partially covered: job ownership, quota separation, S3 storage, and PII-safe telemetry are tested. Follow-up needed for org-scoped export data generation when `req.orgId` is present. |
| Webhooks | A lifecycle event for org A is delivered to org B subscribers or org B can list org A subscribers. | `src/services/webhooks.ts`, `src/repositories/webhookSubscriberRepository.ts`, `src/routes/webhooks.ts`, `src/middleware/webhookVerify.ts` | `src/tests/webhooks.persistence.test.ts`, `src/tests/webhooks.test.ts`, `src/tests/webhooks.e2e.test.ts`, `src/tests/webhookVerify.test.ts` | Covered for repository org filters, event delivery filters, signatures, replay checks, and SSRF guards. |
| Caches | Cached feature flags, rollout buckets, or rate-limit keys are shared across orgs. | `src/services/featureFlags.ts`, `src/middleware/rateLimiter.ts` | `src/tests/featureFlags.test.ts`, `src/tests/featureFlags.rollout.test.ts`, `src/tests/rateLimiter.tiers.test.ts` | Partially covered: feature flag cache keys and rollout buckets include org context. Follow-up needed for an integration test proving rate-limit buckets do not collide across orgs. |

## Required Pattern For New Code

When adding a new tenant-aware path:

1. Put the route under `/api/organizations/:orgId` when possible.
2. Run `authenticate` before org authorization.
3. Use `requireOrgAccess(...)` or `requireOrgRole(...)`.
4. Derive the tenant id from `req.params.orgId` or a trusted server-side context, never from request body fields.
5. Apply tenant predicates before any caller-controlled filters, pagination, batching, DataLoader keys, cache keys, export serialization, or webhook delivery.
6. Add tests with at least two orgs and one dual-membership user when the route supports both orgs.

## Current Follow-Ups

| Gap | Risk | Suggested test |
|-----|------|----------------|
| GraphQL resolvers call `getVaultById`, `listVaults`, and `getAnalyticsByPeriod` without a visible `context.orgId` predicate in `src/routes/graphql.ts`. | A resolver can return data from outside the org authorized by the route. | Add a GraphQL test with org A and org B vault fixtures proving `vault(id:)` rejects or returns null for cross-org ids and `vaults` returns only the route org. |
| Export data generation scopes by user id in `src/services/exportQueue.ts`, while `src/routes/exports.ts` only uses `req.orgId` for quota keys. | An org-scoped export could be quota-isolated but still serialize user-wide data if org exports are introduced. | Add an export test with `req.orgId` and same user in two orgs, then assert generated data contains only the requested org. |
| `src/tests/rateLimiter.tiers.test.ts` checks that `orgId` exists on the mock request but does not exercise the real key generator with two orgs. | Two orgs sharing an IP or API key could accidentally share a limiter bucket if the implementation regresses. | Add a middleware-level test that sends identical IP/API-key inputs with different `req.orgId` values and asserts distinct limiter keys or independent counters. |

## Reviewer Checklist

- Every new org route has an auth middleware and an org-role middleware.
- Every data access call has an explicit tenant predicate before filters or pagination.
- Every cache key that can hold tenant-specific data includes org id or another tenant-safe partition key.
- Every export and webhook path carries tenant identity into async workers or delivery queries.
- Every new tenant path has a cross-org regression test, not only a happy-path test.

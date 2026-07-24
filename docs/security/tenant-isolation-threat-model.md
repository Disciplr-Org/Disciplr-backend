# Multi-tenant data-isolation threat model

> Status: living document — update when controls or tests change.
> 
> Scope: Disciplr-backend (Express + Prisma/in-memory, REST API)

## 1. Trust boundary

JWT `sub` claim (userId) + `orgId` from authenticated route parameter (`req.params.orgId`) and verified org membership separate tenants. A fabricated or deleted `orgId` returns `404 Organization not found` regardless of the caller's role.

## 2. Isolation layers

| Layer | Mechanism | File |
|-------|-----------|------|
| Authentication | JWT signature verification + session validation | `src/middleware/auth.ts` |
| Org access control | Membership + role check on every org-scoped route | `src/middleware/orgAuth.ts` |
| Data scoping | Route handlers filter queries by `orgId` from `req.params` | `src/routes/orgVaults.ts` |
| Export job ownership | Job userId verified before download; admin can target other users | `src/routes/exports.ts` |
| GraphQL auth | `authenticate` + `requireOrgRole` middleware | `src/routes/graphql.ts` |

## 3. Threat vectors and controls

### V1 — Route parameter injection

- **Attack:** Caller substitutes another org's ID in URL param (e.g., `/api/organizations/victim-org-id/vaults`)
- **Control:** `src/middleware/orgAuth.ts::requireOrgAccess()` verifies org existence and membership before any handler executes
- **Test:** `tests/security.integration.test.ts` covers org existence check and membership validation

### V2 — Query filter bypass

- **Attack:** Missing `WHERE orgId=` in list queries returns another tenant's rows
- **Control:** `src/routes/orgVaults.ts` filters all vault results by `req.params.orgId` after membership check; pagination, sorting, filtering applied *after* org-scope
- **Test:** ⚠️ UNTESTED — no specific cross-org leakage test (e.g., create vault in org A, query org B, verify empty result)

### V3 — GraphQL resolver leak

- **Attack:** GraphQL resolver fetches object without tenant check (e.g., `vault` resolver ignores orgId)
- **Control:** `src/routes/graphql.ts` applies `authenticate` + `requireOrgRole` middleware; resolvers use existing services (`getVaultById`, `listVaults`) which are org-agnostic
- **Test:** ⚠️ UNTESTED — no GraphQL-specific cross-org test; resolver orgId scoping relies on future schema implementation

### V4 — Data export / bulk fetch

- **Attack:** Export endpoint streams another tenant's rows or allows caller to export victim's data
- **Control:** `src/routes/exports.ts::POST /me` enforces export quota per `orgId` (resolved from `req.orgId` or `req.user.userId`); `GET /status/:jobId` verifies `job.userId === req.user.userId` or admin override; download token includes `jobId` + `userId`
- **Test:** `tests/exports.test.ts` covers quota enforcement and access denial; cross-org export isolation ⚠️ UNTESTED

### V5 — Webhook / async job fan-out

- **Attack:** Background job processes another org's payload because orgId not passed to handler
- **Control:** `src/jobs/handlers.ts` handlers receive typed `payload` + `context` but do not explicitly scope by orgId; export jobs include `userId` in payload; other jobs (deadline.check, oracle.call, analytics.recompute) lack tenant context
- **Test:** ⚠️ UNTESTED — no test verifies job handlers reject cross-org payloads

### V6 — Cache poisoning

- **Attack:** Cached response served to wrong tenant
- **Control:** No HTTP cache layer (response headers managed by handlers); Prisma scoped per-request via AsyncLocalStorage; in-memory org store is per-process only
- **Test:** ✅ Not applicable — no shared cache layer exists

## 4. Untested vectors (follow-up required)

- **V2 cross-org query leakage** — Add integration test that creates vaults in org A and org B, then queries org A as a member and asserts results do not include org B's vaults.
- **V3 GraphQL resolver orgId scoping** — Add GraphQL integration test that requests a vault ID belonging to another org and asserts `403` or `404` (or `null` if nullable).
- **V4 cross-org export** — Add test that attempts to export from org A as a member of org B and asserts `403` or `404`.
- **V5 async job tenant isolation** — Add test that enqueues a job with orgId in payload, then verifies the handler processes only that org's data. Add orgId context to `notification.send`, `deadline.check`, and `analytics.recompute` handlers.

## 5. How to add a new vector

1. **Identify the tenant touchpoint:** Where does the new feature receive or process orgId or userId?
2. **Trace the data flow:** Does the feature extract orgId from `req.params` (safe) or client-supplied input like `req.body.orgId` (unsafe)? For jobs, is orgId included in the job payload and passed to the handler?
3. **Add to the threat model:** Create a new row in section 3 with the attack, cite the control file(s), and note if the control is tested. If untested, add to section 4.
4. **Add regression tests:** Write tests covering cross-org access attempts (should fail with `403`/`404`) and same-org success paths.

---

See also: [Multi-tenancy and tenant isolation](../multi-tenancy.md)

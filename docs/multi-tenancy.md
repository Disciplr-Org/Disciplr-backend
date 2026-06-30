# Multi-Tenancy and Tenant Isolation

All endpoints mounted under `/api/organizations/:orgId` enforce strict per-organization
data isolation. This document defines the contract that every current and future
org-scoped endpoint must uphold.

## Core isolation rules

1. **Org existence check** — the middleware resolves the org from the in-memory store
   (future: database) before any role check. A fabricated or deleted `orgId` returns
   `404 Organization not found` regardless of the caller's role.

2. **Membership check** — the caller's `userId` (from the verified JWT `sub` claim) must
   appear in the org's member list. Non-members receive `403 Forbidden: not a member of
   this organization`.

3. **Role check** — each endpoint declares the minimum role(s) required. The middleware
   rejects callers whose role is not in the allowed set with
   `403 Forbidden: requires role <roles>`.

4. **Data scoping** — every query inside a handler filters by the `orgId` from
   `req.params`. Client-supplied `orgId` values in query strings or request bodies are
   never trusted for data access decisions.

### Org-scoped retention and hard purge

Retention purge jobs are also scoped to the organization whose ID appears in the job
payload. A per-org retention pass only hard-deletes soft-deleted vaults and related
milestones for that organization.

Retention configuration supports the following environment variables:

- `RETENTION_PURGE_AGE_MS` — minimum age before a soft-deleted vault is eligible for hard purge.
  If unset, the per-org retention window is consulted (see below).
- `RETENTION_PURGE_INTERVAL_MS` — frequency at which the retention scheduler enqueues per-org jobs.
- `RETENTION_PURGE_BATCH_SIZE` — maximum number of vaults deleted per org on each retention run.

Every retention purge also writes an audit log entry scoped to the target organization with a
summary of deleted vault and milestone counts.

### Per-org retention window

Each organization can override the global retention window by setting
`retention_purge_age_ms` in its `metadata` JSONB column:

```sql
UPDATE organizations
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'::jsonb),
  '{retention_purge_age_ms}',
  '604800000'   -- 7 days in milliseconds
)
WHERE id = '<org-uuid>';
```

Resolution order (first match wins):

1. Explicit `retentionAgeMs` argument passed to `purgeSoftDeletedVaults` (testing).
2. `RETENTION_PURGE_AGE_MS` environment variable (global override).
3. `organizations.metadata.retention_purge_age_ms` (per-org override).
4. Built-in default of 30 days (`2_592_000_000` ms).

If the per-org value is missing, unset, or not a valid non-negative number, the system
falls through to the next level. This allows a cluster-wide default via `RETENTION_PURGE_AGE_MS`
while letting individual organizations opt into a shorter (or longer) window through their
metadata.

5. **No cross-org leakage** — pagination, sorting, and filtering are applied *after* the
   org-scope filter. A filter that matches zero records in the target org returns an empty
   result set, not records from another org.

## Roles

| Role     | Description                                      |
|----------|--------------------------------------------------|
| `owner`  | Full control: manage members, access all data.   |
| `admin`  | Manage members (cannot remove last admin), access all data. |
| `member` | Read-only access to org vaults.                  |

## Endpoint access matrix

| Endpoint                                    | Required roles              |
|---------------------------------------------|-----------------------------|
| `GET /api/organizations/:orgId/vaults`      | `owner`, `admin`, `member`  |
| `GET /api/organizations/:orgId/analytics`   | `owner`, `admin`            |
| `GET /api/organizations/:orgId/members`     | `owner`, `admin`, `member`  |
| `POST /api/organizations/:orgId/members`    | `owner`, `admin`            |
| `DELETE /api/organizations/:orgId/members/:userId` | `owner`, `admin`   |
| `PATCH /api/organizations/:orgId/members/:userId/role` | `owner`        |
| `POST /api/organizations/:orgId/invitations` | `owner`, `admin`           |
| `POST /api/organizations/:orgId/invitations/accept` | none (public)   |

## Middleware: `requireOrgAccess`

`src/middleware/orgAuth.ts` exports a single factory used by every org-scoped route:

```ts
requireOrgAccess(...allowedRoles: OrgRole[])
```

It performs the three checks above (org existence → membership → role) in order and
short-circuits with the appropriate HTTP error on the first failure. All org-scoped
routes **must** use this middleware and must not implement their own membership checks.

## Adding a new org-scoped endpoint

1. Mount the route under `/api/organizations`.
2. Apply `authenticate` then `requireOrgAccess(...roles)` before the handler.
3. Inside the handler, scope all data queries to `req.params.orgId`.
4. Add the endpoint to the access matrix above.
5. Add regression tests covering:
   - Unauthenticated request → `401`
   - Non-member → `403`
   - Member with insufficient role → `403`
   - Non-existent org → `404`
   - Cross-org data isolation (response must not contain records from another org)

## IDOR prevention

Org IDs are taken exclusively from the authenticated route parameter (`req.params.orgId`).
They are never read from the request body or query string for access-control decisions.
This prevents insecure direct object reference (IDOR) attacks where a caller could
substitute another org's ID to access its data.

## Dual-membership users

A user may belong to multiple organizations with different roles in each. The middleware
evaluates membership and role against the `orgId` in the current request only. Membership
in org B grants no access to org A's endpoints.

## Organization invitation flow

Admins and owners can invite users by email before they have an existing user account.

### Issue an invitation

```
POST /api/organizations/:orgId/invitations
Authorization: Bearer <admin-token>
{ "email": "newuser@example.com" }
```

Response `201`:
```json
{
  "id": "<uuid>",
  "orgId": "<orgId>",
  "email": "newuser@example.com",
  "expiresAt": "2026-06-09T...",
  "token": "<64-char hex token>"
}
```

The `token` is returned exactly once. The caller is responsible for delivering it
to the recipient (e.g. via email). Only the SHA-256 hash of the token is persisted.

### Accept an invitation

```
POST /api/organizations/:orgId/invitations/accept
{ "token": "<64-char hex token>", "userId": "<new-user-id>", "role": "member" }
```

Response `200`:
```json
{ "orgId": "<orgId>", "userId": "<userId>", "role": "member" }
```

- `role` defaults to `member` if omitted or invalid.
- Tokens expire after 7 days.
- Each token is single-use: `accepted_at` is stamped on acceptance and the row is
  permanently consumed.
- The comparison is constant-time to prevent timing attacks.

### Database schema: `org_invitations`

| Column | Type | Description |
|---|---|---|
| `id` | UUID PK | Auto-generated |
| `org_id` | UUID | FK to organisations |
| `email` | varchar(320) | Invitee email |
| `token_hash` | char(64) | SHA-256 hex of the raw token |
| `expires_at` | timestamptz | 7 days from creation |
| `accepted_at` | timestamptz | Set on acceptance; null = pending |
| `created_at` | timestamptz | Row creation time |

Migration: `db/migrations/20260602120001_create_org_invitations.cjs`

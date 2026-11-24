# API Versioning Strategy

## Overview
The Disciplr API uses **URL-based versioning** with a backward-compatible legacy
alias mechanism. This guarantees that existing integrations never break
abruptly while giving consumers a clear, time-bound migration path.

| Surface | Path pattern | Status |
|---|---|---|
| Current | `/api/v1/...` | **Supported** — no deprecation headers |
| Legacy | `/api/...` | **Deprecated** — sunset scheduled |

## Mounted Router Index

The table below is the authoritative index of calls to
`mountVersionedRoute` in `src/app-bootstrap.ts`. Each row represents one
mount call, in registration order. The legacy and versioned prefixes expose
the same router; the legacy prefix additionally receives deprecation headers.
Some prefixes appear more than once because separate routers are mounted at
the same base path.

| Legacy prefix | Versioned prefix | Router file | Authentication / authorization |
|---|---|---|---|
| `/api/health` | `/api/v1/health` | `src/routes/health.ts` | Public health and deep-health endpoints; `/security` requires JWT authentication and ADMIN role |
| `/api/jobs` | `/api/v1/jobs` | `src/routes/jobs.ts` | JWT authentication and ADMIN role for every endpoint |
| `/api/vaults` | `/api/v1/vaults` | `src/routes/vaults.ts` | Authenticated user or scoped API key, with endpoint-level scope and vault-access checks |
| `/api/vaults/:vaultId/milestones` | `/api/v1/vaults/:vaultId/milestones` | `src/routes/milestones.ts` | JWT authentication plus endpoint-specific user, verifier, wallet-identity, and vault-access checks |
| `/api/auth` | `/api/v1/auth` | `src/routes/auth.ts` | Mixed: register, login, and refresh are public; session, WebAuthn, and role-management operations require authentication (and step-up where applicable) |
| `/api/exports` | `/api/v1/exports` | `src/routes/exports.ts` | JWT authentication for user/admin export and status routes; admin export additionally requires ADMIN; download-token route is token-authorized |
| `/api/transactions` | `/api/v1/transactions` | `src/routes/transactions.ts` | JWT authentication |
| `/api/analytics` | `/api/v1/analytics` | `src/routes/analytics.ts` | Mixed: endpoints require JWT authentication or a scoped API key, depending on the operation |
| `/api/privacy` | `/api/v1/privacy` | `src/routes/privacy.ts` | JWT authentication for privacy export and account-deletion operations |
| `/api/organizations` | `/api/v1/organizations` | `src/routes/orgVaults.ts` | JWT authentication and organization membership/role authorization |
| `/api/organizations` | `/api/v1/organizations` | `src/routes/orgAnalytics.ts` | JWT authentication and organization owner/admin authorization |
| `/api/orgs` | `/api/v1/orgs` | `src/routes/orgAnalytics.ts` | JWT authentication and organization owner/admin authorization |
| `/api/organizations` | `/api/v1/organizations` | `src/routes/orgMembers.ts` | JWT authentication and organization membership/role authorization |
| `/api/orgs` | `/api/v1/orgs` | `src/routes/orgMembers.ts` | JWT authentication and organization membership/role authorization |
| `/api/organizations/:orgId/graphql` | `/api/v1/organizations/:orgId/graphql` | `src/routes/graphql.ts` | JWT authentication and organization membership (admin, member, or viewer) |
| `/api/admin` | `/api/v1/admin` | `src/routes/admin.ts` | JWT authentication and ADMIN role for every endpoint; sensitive operations may also require step-up or confirmation |
| `/api/admin/verifiers` | `/api/v1/admin/verifiers` | `src/routes/adminVerifiers.ts` | JWT authentication and ADMIN role for every endpoint |
| `/api/admin/webhooks` | `/api/v1/admin/webhooks` | `src/routes/adminWebhooks.ts` | JWT authentication and ADMIN role for every endpoint |
| `/api/verifications` | `/api/v1/verifications` | `src/routes/verifications.ts` | JWT authentication; write/bulk operations require VERIFIER and listing requires ADMIN |
| `/api/api-keys` | `/api/v1/api-keys` | `src/routes/apiKeys.ts` | JWT authentication for every endpoint |
| `/api/notifications` | `/api/v1/notifications` | `src/routes/notifications.ts` | JWT authentication for every endpoint |
| `/api/users/me/notification-preferences` | `/api/v1/users/me/notification-preferences` | `src/routes/notificationPreferences.ts` | JWT authentication for every endpoint |
| `/api/webhooks` | `/api/v1/webhooks` | `src/routes/webhooks.ts` | JWT authentication and organization membership/role authorization |

When adding or changing a versioned router, update this index in the same
change. The documentation test compares the prefix pairs and their order with
the `mountVersionedRoute` calls in `src/app-bootstrap.ts`.

---

## Versioning Mechanism

### URL-based versions

The canonical version is embedded in the path:

```
GET /api/v1/health
GET /api/v1/vaults
GET /api/v1/vaults/:id/milestones
```

### Legacy aliases

Every route that exists under `/api/v1/...` is also reachable under the legacy
prefix `/api/...`. The legacy alias behaves **identically** in terms of request
parsing, authentication, and response bodies. The only difference is the
presence of deprecation headers.

---

## Deprecation Headers (RFC 8594)

All legacy (`/api/...`) responses include three headers:

| Header | Example value | Specification |
|---|---|---|
| `Deprecation` | `true` | RFC 8594 — signals the endpoint is deprecated |
| `Sunset` | `Tue, 01 Sep 2026 00:00:00 GMT` | RFC 8594 — last day the endpoint is guaranteed to work |
| `Link` | `</api/v1/health>; rel="successor-version"` | RFC 8288 — direct link to the canonical replacement |

### Example response

```http
HTTP/1.1 200 OK
Deprecation: true
Sunset: Tue, 01 Sep 2026 00:00:00 GMT
Link: </api/v1/health>; rel="successor-version"
Content-Type: application/json

{"status":"ok"}
```

---

## Deprecation Timeline

| Phase | Date | Action |
|---|---|---|
| **Announcement** | Now | Documentation published; `Deprecation` + `Sunset` headers active on all legacy routes |
| **Active support** | Now → 2026-09-01 | Legacy routes continue to function; clients encouraged to migrate |
| **Sunset** | 2026-09-01 | Legacy routes may be removed in a subsequent release; at least 30 days further notice will be given in CHANGELOG |
| **Removal** | TBD (≥ 30 days after sunset) | Legacy aliases removed; only `/api/v1/...` remains |

> The sunset date is defined in `src/config/versions.ts` as `LEGACY_SUNSET_ISO`.

---

## Client Migration Guide

### 1. Detect deprecation in your client

Watch for the `Deprecation` or `Sunset` header on any `/api/...` call:

```typescript
const res = await fetch('/api/vaults');
if (res.headers.get('Deprecation')) {
  console.warn('This endpoint is deprecated. Migrate before', res.headers.get('Sunset'));
}
```

### 2. Update base URL

Replace the base path prefix:

| Before | After |
|---|---|
| `https://api.disciplr.io/api/health` | `https://api.disciplr.io/api/v1/health` |
| `https://api.disciplr.io/api/vaults` | `https://api.disciplr.io/api/v1/vaults` |

If you construct URLs dynamically, prepend `/api/v1` instead of `/api`.

### 3. Verify behaviour

After switching, confirm:
- Response HTTP status codes are unchanged
- Response bodies are unchanged
- **No** `Deprecation` or `Sunset` headers are returned

### 4. Rollback safety

If a bug is discovered after migration, you can temporarily revert to the
legacy alias while the issue is investigated — the legacy route will continue
to work until the sunset date.

---

## Testing Versions

The test suite enforces versioning correctness:

- **`/api/v1/...` must NOT emit deprecation headers.**
- **`/api/...` must emit `Deprecation`, `Sunset`, and `Link` headers.**
- Response payloads must be identical across both paths.

Run the versioning tests:

```bash
npm test -- src/tests/apiVersioning.test.ts
```

The router-index regression test also verifies that every documented prefix
pair appears in `src/app-bootstrap.ts` and remains in mount order:

```bash
npm test -- src/tests/docs.apiVersioning.test.ts
```

---

## FAQ

### What happens after the sunset date?

Legacy aliases may be removed in a future release. A minimum of 30 days
additional notice will be published in the CHANGELOG before removal.

### Will there be a v2?

If a breaking change becomes necessary, a new `/api/v2/...` prefix will be
introduced using the same dual-registration pattern. `/api/v1/...` will then
enter its own deprecation cycle.

### Why URL versioning instead of header versioning?

URL versioning is explicit, cache-friendly, and easy to inspect in logs and
browser dev-tools. Header-based versioning is supported for read-only
negotiation (`Accept-Version`) but the canonical identity of a resource is
always its URL.

### Can I opt out of deprecation headers?

Yes — simply call the versioned path (`/api/v1/health`). No headers related to
deprecation are sent on versioned routes.

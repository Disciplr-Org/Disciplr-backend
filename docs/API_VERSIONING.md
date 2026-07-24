# API Versioning Strategy

## Overview

The Disciplr API uses **URL-based versioning** with a backward-compatible legacy
alias mechanism. This guarantees that existing integrations never break
abruptly while giving consumers a clear, time-bound migration path.

| Surface | Path pattern | Status |
|---|---|---|
| Current | `/api/v1/...` | **Supported** — no deprecation headers |
| Legacy | `/api/...` | **Deprecated** — sunset scheduled |

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

Yes — simply call the versioned path (`/api/v1/...`). No headers related to
deprecation are sent on versioned routes.


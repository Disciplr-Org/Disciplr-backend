# API Versioning & Deprecation Policy

## Versioning Scheme

Disciplr uses **URL-based prefix versioning**. Every API endpoint is scoped under a version prefix:

```
/api/v1/health
/api/v1/vaults
/api/v1/auth/login
```

## Current Versions

| Version | Status     | Base Path |
| ------- | ---------- | --------- |
| `v1`    | **Stable** | `/api/v1` |

## Response Headers

Every response includes an `Api-Version` header indicating the version that served the request:

```
Api-Version: v1
```

## Backward Compatibility

Unversioned requests to `/api/*` are temporarily redirected (**HTTP 307**) to the latest stable version (`/api/v1/*`). This preserves the original HTTP method (POST, PUT, DELETE, etc.) through the redirect.

> **Note:** This redirect layer exists for backward compatibility during migration. Clients should update to use versioned URLs directly.

## Introducing a New Version

1. Create a new aggregation router (e.g. `src/routes/v2.ts`).
2. Mount it at `/api/v2` in `app.ts`.
3. Update the unversioned redirect to point to the new stable version.
4. Begin deprecation of the previous version.

## Deprecation Policy

When a new version is released:

1. The previous version receives a **6-month support window** minimum.
2. Deprecated versions include a `Deprecation: true` header and a `Sunset` header with the planned removal date (RFC 7231).
3. Deprecation is announced in the changelog and API docs at least **3 months** before the sunset date.
4. After the sunset date, deprecated endpoints return `410 Gone`.

## What Constitutes a Breaking Change

The following require a **new API version**:

- Removing or renaming an endpoint.
- Removing or renaming a required request/response field.
- Changing the type of an existing field.
- Changing the meaning or behavior of an existing field.
- Changing error response codes for existing conditions.

The following are **non-breaking** and may be added to the current version:

- Adding a new endpoint.
- Adding an optional request field.
- Adding a new field to a response body.
- Adding a new query parameter.
- Fixing a bug that caused incorrect behavior.

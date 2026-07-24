# CORS Configuration

## Overview
The backend uses a strict CORS allowlist system to control cross-origin requests. All allowed origins must be explicitly configured via the `CORS_ORIGINS` environment variable.

## Allowlist Behavior
| Scenario | Behavior |
|----------|----------|
| Origin in allowlist | Sets `Access-Control-Allow-Origin` to the request origin, includes credentials header |
| Origin not in allowlist | No CORS headers returned (blocks request) |
| No Origin header (server-to-server) | Allowed, no CORS headers |
| Origin: `null` | Blocked (treated as untrusted), no CORS headers |
| `CORS_ORIGINS=*` | Allows all origins, **disables credentials** |

## Environment Configuration
Set `CORS_ORIGINS` as a comma-separated list of allowed origins:
```bash
CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

### Validation Rules
- Must be either `*` (wildcard) or a comma-separated list of origins
- `*` cannot appear as part of a list (e.g., `https://a.com,*` is invalid)
- In production, `CORS_ORIGINS` **cannot be `*`** (must use explicit origins)
- Invalid values throw clear startup errors

## Credentials Handling
- When using explicit origins: `Access-Control-Allow-Credentials: true` is set
- When using wildcard (`*`): credentials are disabled (browsers reject `*` with credentials)
- Credentials require echoing the exact request origin (never `*`)

## Allowed Headers
All CORS responses include:
- `Content-Type`
- `Authorization`
- `idempotency-key`

## Production Recommendations
1. Avoid using `*` in production
2. Restrict to known, trusted HTTPS domains
3. Use comma-separated list for multiple allowed origins
4. Validate configuration in CI/CD pipelines
5. Monitor rejected origin logs (`security.cors_rejected` events)

## Examples
```bash
# Development (default if unset)
CORS_ORIGINS=http://localhost:3000

# Production
CORS_ORIGINS=https://app.disciplr.com,https://admin.disciplr.com

# Invalid (production)
CORS_ORIGINS=*  # Throws startup error

# Invalid (any environment)
CORS_ORIGINS=https://a.com,*  # Validation fails
```

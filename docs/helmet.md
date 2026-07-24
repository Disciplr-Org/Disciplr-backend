# Helmet Security Header Policy

## Purpose

The API applies a strict Helmet profile in `src/app.ts` to reduce browser-side abuse risk even for JSON-only endpoints.

This document explains the policy intent and links to contract tests that protect it from regressions.

## Policy Contract

The active security-header contract is asserted in `src/tests/helmet.test.ts`.

Representative endpoint coverage includes:
- Unauthenticated endpoints: `GET /`, `GET /api/health`
- Authenticated endpoint: `GET /api/vaults`
- Admin endpoint: `GET /api/admin/audit-logs`

Assertions are environment-agnostic and validate directive/tokens rather than host-specific serialized values.

## Expected Headers

### Content-Security-Policy
- Must include `default-src 'none'`
- Must include `frame-ancestors 'none'`

Rationale:
- API responses should not execute active browser content.
- Framing is blocked via CSP (`frame-ancestors`) instead of legacy `X-Frame-Options`.

### Strict-Transport-Security
- Must include `max-age=31536000`
- Must include `includeSubDomains`
- Must not include `preload`

Rationale:
- Enforces long-lived HTTPS transport policy for one year with subdomain coverage.
- `preload` is intentionally omitted until the domain is submitted to browser preload lists.

### Other Required Security Headers
- `referrer-policy: no-referrer`
- `x-content-type-options: nosniff`
- `cross-origin-resource-policy: same-site`
- `cross-origin-opener-policy: same-origin`
- `x-dns-prefetch-control: off`
- `x-permitted-cross-domain-policies: none`

### Required Header Absences
- `x-frame-options` must be absent (superseded by CSP `frame-ancestors`)
- `x-powered-by` must be absent

## Traceability

- Runtime configuration source of truth: `src/app.ts`
- Contract tests: `src/tests/helmet.test.ts`
- Security integration overview: `docs/SECURITY_INTEGRATION_TESTS.md`

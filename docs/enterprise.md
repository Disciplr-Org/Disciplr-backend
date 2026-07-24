# Enterprise Features Documentation

## Overview
The Disciplr Enterprise API provides dedicated endpoints for institutional users and savings groups. It enforces strict authorization and data exposure controls to ensure multi-tenant isolation and security.

## Authorization Flow
Enterprise access is managed through the `enterpriseGuard` middleware. Eligibility is determined by the `isEnterprise` flag in the JWT auth context, which is populated during authentication.

### Eligibility Criteria
- User must be authenticated.
- User must belong to an organization marked as an enterprise.
- The `enterpriseId` must be present in the auth context.

### Guard Behavior
- **Non-Enterprise Users**: Receive a `403 Forbidden` response.
- **Unauthenticated Requests**: Receive a `401 Unauthorized` response.
- **Unauthorized Access Attempts**: Logged to the security audit trail with the `security.enterprise_denied` event.
- **Misconfigured/Absent Tier**: Defaults to **deny** (fail-closed). If `isEnterprise` is missing, `null`, or `false`, or if `enterpriseId` is absent or empty, the request is rejected with `403`.

## Access Decision Matrix

The table below documents every combination that `enterpriseGuard` evaluates. Tests in `src/tests/enterpriseGuard.test.ts` cover each row.

| `req.user` | `isEnterprise` | `enterpriseId` | Decision | HTTP |
|------------|----------------|----------------|----------|------|
| absent | — | — | Unauthenticated | 401 |
| present | `false` | any | Non-enterprise | 403 |
| present | `undefined` / `null` | any | Fail-closed (missing tier) | 403 |
| present | `true` | absent / `""` | Misconfiguration | 403 |
| present | `true` | valid string | Allowed | next() |

## Exposure Controls
The Enterprise API implements strict data exposure controls to prevent leakage of internal metadata:
1. **PII Masking**: Sensitive identifiers (e.g., creator addresses) are masked using deterministic hashing for observability.
2. **Public DTOs**: Internal database models are mapped to `EnterpriseVault` and `EnterpriseMilestone` DTOs, stripping fields like `created_at`, `updated_at`, and internal notes.
3. **Identifier Validation**: Enterprise identifiers are strictly retrieved from the verified auth context, preventing ID guessing or cross-tenant leakage.

## Rollout Approach
Enterprise features are controlled via a feature flag matrix:
- **`isEnterprise`**: Global flag per user/org.
- **`enterpriseId`**: Scopes data access to a specific tenant.

### Feature Flag Matrix
| Feature | Flag Requirement | Status |
|---|---|---|
| Enterprise Routes | `isEnterprise: true` | Active |
| Custom Milestones | `enterprise_custom_milestones: true` | In Development |
| Advanced Analytics | `enterprise_analytics_tier: 'premium'` | In Development |

## Security Assumptions
- JWTs are signed and cannot be tampered with.
- The `isEnterprise` flag is accurately populated by the Identity Provider or the core auth service.
- All enterprise-specific data is tagged with an `organization_id` for isolation.

## Feature Flag Service

### Overview

The Feature Flag Service provides runtime-configurable boolean flags that enable gradual rollouts, A/B testing, and per-organization feature control without requiring code deployments.

### Architecture

- **Scope**: Global defaults with per-organization overrides
- **Storage**: PostgreSQL `feature_flags` table
- **Caching**: Per-process LRU cache (1000 entries max, 5-minute TTL)
- **Fallback**: Organization-specific → Global → False (default)

### Available Flags

All flags are defined in the `FeatureFlag` enum in `src/services/featureFlags.ts`:

| Flag Name | Purpose | Default |
|-----------|---------|---------|
| `ENTERPRISE_ANALYTICS` | Enable advanced analytics dashboard for enterprise orgs | `false` |
| `MULTI_VERIFIER_ENABLED` | Enable multi-signature vault verification | `false` |
| `ORGANIZATION_QUOTAS` | Enable org-level resource quotas and limits | `false` |
| `ADVANCED_ANALYTICS` | Enable machine learning-driven analytics insights | `false` |

To add a new flag:
1. Add to the `FeatureFlag` enum in `src/services/featureFlags.ts`
2. Seed it in the migration `db/migrations/20260603000000_create_feature_flags.cjs`
3. Use `getFlag()` in your endpoint handlers

### Admin Endpoints

#### Get All Flags

```http
GET /api/admin/flags
GET /api/admin/flags?orgId=org-123
```

**Query Parameters:**
- `orgId` (optional): Organization ID to fetch org-specific overrides merged with global defaults

**Response:**
```json
{
  "data": {
    "orgId": "org-123",
    "flags": {
      "ENTERPRISE_ANALYTICS": true,
      "MULTI_VERIFIER_ENABLED": false,
      "ORGANIZATION_QUOTAS": true,
      "ADVANCED_ANALYTICS": false
    },
    "timestamp": "2025-06-03T14:30:00Z"
  }
}
```

#### Set Feature Flag

```http
PATCH /api/admin/flags/:name
```

**Request Body:**
```json
{
  "enabled": true,
  "orgId": "org-123"
}
```

**Parameters:**
- `:name` - Feature flag name (from `FeatureFlag` enum)
- `enabled` (required) - Boolean to enable/disable the flag
- `orgId` (optional) - Organization ID for org-specific override; omit for global flag

**Response:**
```json
{
  "data": {
    "flag": "ENTERPRISE_ANALYTICS",
    "orgId": "org-123",
    "enabled": true,
    "timestamp": "2025-06-03T14:30:00Z"
  }
}
```

**Error Responses:**
- `400 Bad Request` - Invalid flag name or request body
- `403 Forbidden` - User is not an admin
- `500 Internal Server Error` - Database error

**Examples:**

Enable flag globally:
```bash
curl -X PATCH https://api.disciplr.com/api/admin/flags/ENTERPRISE_ANALYTICS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

Enable flag for specific organization:
```bash
curl -X PATCH https://api.disciplr.com/api/admin/flags/MULTI_VERIFIER_ENABLED \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "orgId": "org-123"}'
```

Disable flag for organization:
```bash
curl -X PATCH https://api.disciplr.com/api/admin/flags/ENTERPRISE_ANALYTICS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false, "orgId": "org-456"}'
```

### Client-Side Usage

Handlers should check feature flags at runtime to gate features:

```typescript
import { getFlag, FeatureFlag } from '../services/featureFlags'

// In an endpoint handler
app.get('/api/analytics/advanced', async (req, res) => {
  const orgId = req.user?.orgId
  
  // Check if feature is enabled for this org
  const advancedAnalyticsEnabled = await getFlag(
    FeatureFlag.ADVANCED_ANALYTICS,
    orgId
  )
  
  if (!advancedAnalyticsEnabled) {
    return res.status(403).json({
      error: 'Advanced analytics not available for this organization'
    })
  }
  
  // Feature is enabled, proceed with implementation
  const analytics = await computeAdvancedMetrics(orgId)
  res.json(analytics)
})
```

For middleware or service-layer checks:

```typescript
import { getAllFlags } from '../services/featureFlags'

// Get all flags for an org at once (more efficient than multiple getFlag calls)
const flags = await getAllFlags(orgId)

if (flags.ORGANIZATION_QUOTAS) {
  // Apply quota logic
  enforceOrgQuotas(orgId)
}
```

### Org-Level Overrides

Organizations can have custom feature settings that override global defaults:

**Scenario:** Global `ENTERPRISE_ANALYTICS` is `false`, but org-123 has it enabled:

```bash
# Set global (all orgs get this unless overridden)
curl -X PATCH https://api.disciplr.com/api/admin/flags/ENTERPRISE_ANALYTICS \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"enabled": false}'

# Override for specific org
curl -X PATCH https://api.disciplr.com/api/admin/flags/ENTERPRISE_ANALYTICS \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"enabled": true, "orgId": "org-123"}'
```

Now when org-123 fetches the flag, they get `true` (override), while other orgs get `false` (global default).

### Performance & Caching

**Cache Strategy:**
- First call for a flag: queries database
- Subsequent calls (within 5 minutes): returns cached value
- After 5 minutes: cache expires, next call queries database
- Cache invalidation: automatic on `setFlag()` updates

**Cache Hit Example:**
```
Request 1: getFlag('ENTERPRISE_ANALYTICS', 'org-123')
  → Cache miss, query DB, store in cache
Request 2: getFlag('ENTERPRISE_ANALYTICS', 'org-123')  [within 5 min]
  → Cache hit, return immediately (~1ms vs ~20ms for DB query)
Request 3: setFlag('ENTERPRISE_ANALYTICS', 'org-123', false)
  → Cache invalidated for this key
Request 4: getFlag('ENTERPRISE_ANALYTICS', 'org-123')
  → Cache miss, query DB with fresh value
```

**Monitoring Cache Stats:**
```typescript
import { getCacheStats } from '../services/featureFlags'

const stats = getCacheStats()
console.log(`Cache entries: ${stats.size}/${stats.maxSize}`)
```

### Audit Logging

All flag changes are automatically logged to the audit trail:

```json
{
  "action": "admin.feature_flag.update",
  "target_type": "feature_flag",
  "target_id": "ENTERPRISE_ANALYTICS:org-123",
  "metadata": {
    "flag_name": "ENTERPRISE_ANALYTICS",
    "org_id": "org-123",
    "enabled": true,
    "timestamp": "2025-06-03T14:30:00Z"
  }
}
```

Query audit logs to track who changed what and when:

```bash
curl "https://api.disciplr.com/api/admin/audit-logs?action=admin.feature_flag.update" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Best Practices

1. **Always check at request time** - Don't cache flag values in your code; let the service handle caching
2. **Use enum for type safety** - Import `FeatureFlag` enum and use its values, not magic strings
3. **Provide fallback behavior** - If a flag doesn't exist, the service returns `false`; handle this gracefully
4. **Document flag purpose** - Add comments explaining why a flag exists and when to remove it
5. **Gradual rollout** - Start with org-specific flags, then enable globally after validation
6. **Monitor via audit logs** - Use audit trail to track who enabled/disabled what and audit access to analytics features

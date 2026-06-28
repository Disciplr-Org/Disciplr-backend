# Cache Architecture & Invalidation

This document details the cache-aside design, namespacing conventions, and invalidation triggers implemented in the backend application.

## Key Namespaces

To support multi-tenancy and ensure that writes from one organization never evict or affect cache entries of another, all cache keys are namespaced by organization ID.

Key format:
*   **Namespaced Key:** `org:{orgId}:{key}` (e.g. `org:d3b07384-d113-4956-a50f-21101750508a:vault:123`)
*   **Global Key:** `{key}` (used for global operations or feature flags without organization context)

## Cache Helpers

The cache-aside layer in [cache.ts](file:///c:/Users/HP/Disciplr-backend/src/lib/cache.ts) exports the following core functions supporting namespaced operations:

*   `getOrSet<T>(key, ttlSeconds, loader, orgId?)`: Retrieves a value from the cache or loads and saves it using the namespaced key.
*   `invalidate(key, orgId?)`: Evicts a single key from the cache. Idempotent and safe to call when the key is absent.
*   `invalidatePrefix(prefix, orgId?)`: Scans and evicts all keys matching the prefix pattern within the namespaced scope. Uses non-blocking `SCAN` and `UNLINK` in Redis.

## Invalidation Triggers

Caching invalidation is triggered on the write paths of mutations to prevent serving stale cached data.

### 1. Vault Writes
Whenever a vault is created, updated, or cancelled in [vaultStore.ts](file:///c:/Users/HP/Disciplr-backend/src/services/vaultStore.ts):
*   `invalidate('vault:<vaultId>', orgId)`: Evicts the specific vault cache entry.
*   `invalidate('vault:<vaultId>:org')`: Evicts the vault-to-org lookup cache mapping.
*   `invalidatePrefix('vaults:', orgId)`: Evicts all cached lists of vaults for that organization.
*   `invalidatePrefix('analytics:', orgId)`: Evicts cached analytics for that organization.
*   `invalidate('analytics:overall')`: Evicts global overall analytics.

### 2. Analytics Refresh
Whenever the analytics summary is updated or refreshed in [analytics.service.ts](file:///c:/Users/HP/Disciplr-backend/src/services/analytics.service.ts):
*   `invalidate('analytics:overall', orgId)`: Evicts overall namespaced analytics.

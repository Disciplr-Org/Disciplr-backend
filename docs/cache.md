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
*   `getOrLoad<T>(key, ttlSeconds, loader, orgId?, options?)`: Single-flight (request-coalescing) variant that protects against cache stampedes. See [Stampede Protection](#stampede-protection) below.
*   `invalidate(key, orgId?)`: Evicts a single key from the cache. Idempotent and safe to call when the key is absent.
*   `invalidatePrefix(prefix, orgId?)`: Scans and evicts all keys matching the prefix pattern within the namespaced scope. Uses non-blocking `SCAN` and `UNLINK` in Redis.

## Stampede Protection

The `getOrLoad` function extends `getOrSet` with three additional mechanisms:

### 1. Single-Flight Coalescing (In-Memory)

When a cache miss occurs, the first caller starts the loader and stores the in-flight promise in a local map. Subsequent concurrent callers that miss await the same promise instead of invoking the loader again. This guarantees exactly one `loader()` call per key across any number of concurrent requests within the same process.

```typescript
const value = await getOrLoad('my-key', 300, expensiveLoader)
```

### 2. Distributed Locking (Redis)

For multi-replica deployments backed by Redis, `getOrLoad` uses a short-lived `SET NX PX` lock key (`lock:{key}`). The first replica to acquire the lock runs the loader. Other replicas poll the cache key for up to 5 seconds (or the SWR window, whichever is shorter). If the value appears they return it; otherwise they fall back to serving a stale value or, as a last resort, proceed as the loader after the lock TTL (10 s) expires.

### 3. Stale-While-Revalidate (SWR)

After the TTL expires but within the SWR window (default: `2 × ttlSeconds`), `getOrLoad` serves the last-known value and triggers a single background refresh. All concurrent readers during the refresh also receive the stale value — they are never blocked by the refresh. The refresh runs at most once per key regardless of how many readers observe the stale entry.

```typescript
const value = await getOrLoad('analytics:overall', 300, loadAnalytics, orgId, {
  swrSeconds: 600,  // serve stale for up to 10 minutes
})
```

### Error Handling

If the loader throws, the error is propagated to all concurrent waiters, the in-flight promise is cleaned up, and the Redis lock (if any) is released. Subsequent calls after a failure will retry the loader. Background refresh failures are silently swallowed — the stale cache entry is preserved until the next refresh attempt.

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

## Performance Benchmark

The cache-aside layer is covered by a dedicated benchmark that measures hit ratio
and read latency for the vault and analytics read paths. The benchmark uses the
in-memory LRU implementation (no Redis) so measurements are fully deterministic.

Key thresholds enforced:
*   **Hit ratio** ≥ 95 % after a single warm-up miss
*   **p95 in-memory hit latency** < 5 ms

See [performance-testing.md — Cache Read Benchmark](performance-testing.md#cache-read-benchmark)
for the full coverage table, budget constants, and instructions for running the suite.

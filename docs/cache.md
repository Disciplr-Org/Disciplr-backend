# Cache Architecture & Invalidation

This document captures the cache-aside strategy used by the backend for read-heavy paths such as vault and analytics reads. It is intended to be a reference for contributors so cache usage stays consistent and safe.

## Cache Strategy Overview

The implementation in [src/lib/cache.ts](../src/lib/cache.ts) uses a small cache-aside layer with two backends:

- Redis when REDIS_URL is configured.
- An in-process LRU cache when Redis is unavailable or not configured.

The layer is best used for read paths that are expensive or frequently repeated and where a short-lived stale value is acceptable until invalidation occurs.

## Key Namespace Convention

To preserve tenant isolation, all cache entries are namespaced by organization ID when an orgId is supplied.

- Namespaced key format: `org:{orgId}:{key}`
- Global key format: `{key}`

Examples:
- `org:acme-org:vault:123`
- `org:acme-org:analytics:overall`

This convention is implemented by the cache helpers in [src/lib/cache.ts](../src/lib/cache.ts) and is used by the vault and analytics services.

## Cache Helpers

The cache layer exports three helpers:

- `getOrSet(key, ttlSeconds, loader, orgId?)`: reads from cache if present; otherwise calls the loader, stores the value, and returns it.
- `invalidate(key, orgId?)`: removes a single cache entry for the namespaced or global key.
- `invalidatePrefix(prefix, orgId?)`: removes all entries whose keys share the given prefix within the org namespace.

These helpers are used by the vault and analytics read paths. The current implementation uses the same cache key shape for both Redis and the in-memory fallback.

## TTL Policy

TTL is supplied per call to `getOrSet` and is expressed in seconds. The implementation does not impose a global TTL; the caller chooses the retention window.

Current uses include:

- Vault and analytics reads use a 300-second TTL for overall analytics summaries.
- Other cache entries in tests and local integrations use short TTLs such as 10 or 60 seconds.

The TTL is applied as a Redis EXPIRE value when Redis is active and as an expiry timestamp in the in-memory LRU cache otherwise.

## Cache Versioning and Safe Shape Changes

The cache payload includes a version field named `CACHE_VERSION`.

- Current value: `v1`
- The value is stored as part of the cached payload and checked on read.
- A mismatched version causes the entry to be treated as a miss and reloaded.

This is the safe mechanism for changing cached shapes. If the serialized payload format changes, bump `CACHE_VERSION` and ensure the loader can deserialize the new shape correctly.

## Invalidation Triggers

Cache invalidation is required on write paths so readers do not serve stale data. The current implementation expects callers to invalidate affected keys after mutations.

### Vault mutations

Vault writes in [src/services/vaultStore.ts](../src/services/vaultStore.ts) invalidate:

- `vault:{vaultId}`
- `vault:{vaultId}:org`
- all `vaults:` entries for the org
- all `analytics:` entries for the org
- `analytics:overall`

### Analytics refresh

Analytics updates in [src/services/analytics.service.ts](../src/services/analytics.service.ts) invalidate `analytics:overall` for the relevant org scope.

## Fallback and Failure Behaviour

The cache implementation prefers Redis when `REDIS_URL` is configured. If Redis is unavailable or the client fails, the layer falls back to the in-memory LRU cache instead of failing the request.

This is a fail-open behavior for cache availability, not for correctness. If a cache read fails because of a transient Redis issue, the loader still runs and the value is returned.

## Checklist for Adding a New Cached Read

Before introducing a new cached read, confirm all of the following:

1. The read is safe to serve from a short-lived cache.
2. The cache key is namespaced correctly with `org:{orgId}:{key}` when the data is tenant-scoped.
3. The TTL is appropriate for the freshness requirement.
4. The write path invalidates the key or prefix after mutations.
5. The payload shape is versioned with `CACHE_VERSION` when it may evolve.
6. The documented behavior still matches the implementation after any change.

## Performance Notes

The in-memory LRU implementation is used by the performance benchmark suite for deterministic measurements. The benchmark targets a high hit ratio and low in-memory hit latency for cached read paths.

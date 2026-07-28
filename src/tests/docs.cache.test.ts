import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

function readFile(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('docs/cache.md drift guard', () => {
  const doc = readFile('docs/cache.md');
  const cacheSource = readFile('src/lib/cache.ts');

  it('documents the org-scoped namespace format and the cache version', () => {
    expect(doc).toContain('org:{orgId}:{key}');
    expect(doc).toContain('CACHE_VERSION');
    expect(cacheSource).toContain("const CACHE_VERSION = 'v1';");
  });

  it('documents Redis fallback behaviour and the in-memory LRU implementation', () => {
    expect(doc).toContain('Redis');
    expect(doc).toContain('LRU');
    expect(doc).toContain('fallback');
    expect(cacheSource).toContain('class InMemoryLRUCache');
    expect(cacheSource).toContain("if (env.REDIS_URL)");
  });

  it('mentions the supported cache helpers and the invalidation contract', () => {
    expect(doc).toContain('getOrSet');
    expect(doc).toContain('invalidatePrefix');
    expect(doc).toContain('invalidate');
    expect(doc).toContain('invalidation');
  });
});

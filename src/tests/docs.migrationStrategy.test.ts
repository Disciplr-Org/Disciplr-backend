import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const nodeTest = typeof describe === 'undefined' ? await import('node:test') : null;
const testDescribe = typeof describe !== 'undefined' ? describe : nodeTest!.describe;
const testIt = typeof it !== 'undefined' ? it : nodeTest!.it;

const ROOT = process.cwd();

function getFilePath(relPath: string): string {
  return resolve(ROOT, relPath);
}

function readFile(relPath: string): string {
  const absPath = getFilePath(relPath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${relPath}`);
  }
  return readFileSync(absPath, 'utf8');
}

testDescribe('Migration Strategy Runbook Documentation Verification', () => {
  const runbookPath = 'docs/runbooks/migration-strategy.md';
  const baseDocPath = 'docs/database-migrations.md';
  const packageJsonPath = 'package.json';

  testIt('runbook file exists and is non-empty', () => {
    const content = readFile(runbookPath);
    assert.ok(content.length > 0, 'Runbook content should not be empty');
  });

  testIt('verifies bi-directional cross-linking with database-migrations.md', () => {
    const runbookContent = readFile(runbookPath);
    const baseDocContent = readFile(baseDocPath);

    assert.match(
      runbookContent,
      /database-migrations\.md/,
      'Runbook must link to database-migrations.md'
    );
    assert.match(
      baseDocContent,
      /runbooks\/migration-strategy\.md/,
      'Database migrations doc must link to runbooks/migration-strategy.md'
    );
  });

  testIt('contains all required architectural sections', () => {
    const content = readFile(runbookPath);

    const requiredSections = [
      /Expand\/Contract|Additive-Then-Cleanup/i,
      /CREATE INDEX CONCURRENTLY/i,
      /statement_timeout/i,
      /migrate:rollback/i,
    ];

    for (const pattern of requiredSections) {
      assert.match(content, pattern, `Runbook must contain section matching ${pattern}`);
    }
  });

  testIt('includes deep technical guidance on concurrent indexing edge cases', () => {
    const content = readFile(runbookPath);

    assert.match(
      content,
      /SHARE/i,
      'Runbook must explain SHARE locks incurred by standard index creation'
    );
    assert.match(
      content,
      /transaction:\s*false/i,
      'Runbook must detail disabling transactions via transaction: false for concurrent indexing'
    );
    assert.match(
      content,
      /INVALID/i,
      'Runbook must document handling invalid indexes from failed concurrent indexing'
    );
  });

  testIt('asserts all referenced npm scripts exist in package.json', () => {
    const content = readFile(runbookPath);
    const packageJsonContent = readFile(packageJsonPath);
    const pkg = JSON.parse(packageJsonContent);
    const availableScripts = pkg.scripts || {};

    const scriptMatches = content.match(/npm run ([a-zA-Z0-9:-]+)/g) || [];
    const referencedScripts = Array.from(
      new Set(scriptMatches.map((m) => m.replace('npm run ', '').trim()))
    );

    assert.ok(referencedScripts.length > 0, 'Should find referenced npm scripts in runbook');

    for (const scriptName of referencedScripts) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(availableScripts, scriptName),
        `Referenced script "${scriptName}" in runbook must exist in package.json`
      );
    }
  });
});

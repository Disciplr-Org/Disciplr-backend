import { readFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const runbookPath = path.resolve(process.cwd(), 'docs/runbooks/disaster-recovery.md')

test('disaster recovery runbook references the current migration tooling and checkpoint table', () => {
  const contents = readFileSync(runbookPath, 'utf8')

  assert.match(contents, /knex migrate:latest --knexfile knexfile\.cjs/i)
  assert.match(contents, /knex migrate:status --knexfile knexfile\.cjs/i)
  assert.match(contents, /horizon_checkpoints/i)
})

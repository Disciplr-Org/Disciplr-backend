import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from '@jest/globals'

const runbookPath = path.resolve(process.cwd(), 'docs/runbooks/disaster-recovery.md')

it('disaster recovery runbook references the current migration tooling and checkpoint table', () => {
  const contents = readFileSync(runbookPath, 'utf8')

  expect(contents).toMatch(/knex migrate:latest --knexfile knexfile\.cjs/i)
  expect(contents).toMatch(/knex migrate:status --knexfile knexfile\.cjs/i)
  expect(contents).toMatch(/horizon_checkpoints/i)
})

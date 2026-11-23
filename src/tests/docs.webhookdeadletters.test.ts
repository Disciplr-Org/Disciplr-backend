/**
 * docs.webhookdeadletters.test.ts
 *
 * Drift guard: asserts that every endpoint path, metric field, DB table, and
 * log event/action name referenced in docs/runbooks/webhook-dead-letters.md exists
 * somewhere in the source tree. If a name is renamed in code without updating the
 * runbook, or vice-versa, one of these tests will fail.
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from '@jest/globals'

const ROOT = process.cwd()

function readFile(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

/** Recursively collect *.ts files under a directory (relative to ROOT). */
function collectTs(dir: string): string[] {
  const abs = join(ROOT, dir)
  const entries = readdirSync(abs, { withFileTypes: true })
  const files: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      files.push(...collectTs(`${dir}/${e.name}`))
    } else if (e.name.endsWith('.ts')) {
      files.push(`${dir}/${e.name}`)
    }
  }
  return files
}

let _srcCorpus: string | undefined
function srcCorpus(): string {
  if (!_srcCorpus) {
    _srcCorpus = collectTs('src').map(readFile).join('\n')
  }
  return _srcCorpus!
}

const runbook = readFile('docs/runbooks/webhook-dead-letters.md')

// ── Runbook file existence ────────────────────────────────────────────────────

describe('docs/runbooks/webhook-dead-letters.md', () => {
  it('exists and is non-empty', () => {
    expect(runbook.length).toBeGreaterThan(0)
  })

  it('is cross-linked from docs/webhooks.md', () => {
    const webhooksDoc = readFile('docs/webhooks.md')
    expect(webhooksDoc).toMatch('runbooks/webhook-dead-letters.md')
  })

  it('is cross-linked from docs/operations.md', () => {
    const operationsDoc = readFile('docs/operations.md')
    expect(operationsDoc).toMatch('runbooks/webhook-dead-letters.md')
  })
})

// ── Admin endpoints ───────────────────────────────────────────────────────────

describe('Runbook endpoint references exist in source', () => {
  const endpoints = [
    '/dead-letters',
    '/pause/status',
    '/pause',
    '/resume',
    '/egress-allowlist',
  ]

  for (const endpoint of endpoints) {
    it(`endpoint "${endpoint}" is referenced in runbook`, () => {
      expect(runbook).toMatch(endpoint)
    })

    it(`endpoint "${endpoint}" is registered in source`, () => {
      expect(srcCorpus()).toMatch(endpoint)
    })
  }
})

// ── Metric / response field names ────────────────────────────────────────────

describe('Runbook field references exist in source', () => {
  const fields = ['webhook_dead_letters', 'breaker_state', 'last_failure_reason', 'replayed']

  for (const field of fields) {
    it(`field "${field}" is referenced in runbook`, () => {
      expect(runbook).toMatch(field)
    })

    it(`field "${field}" is present in source`, () => {
      expect(srcCorpus()).toMatch(field)
    })
  }
})

// ── Audit actions ─────────────────────────────────────────────────────────────

describe('Runbook audit actions exist in source', () => {
  const actions = [
    'webhook.deadletter.replay',
    'webhook.window_replay',
    'webhook.delivery.paused',
    'webhook.delivery.resumed',
  ]

  for (const action of actions) {
    it(`audit action "${action}" is referenced in runbook`, () => {
      expect(runbook).toMatch(action)
    })

    it(`audit action "${action}" is used in source`, () => {
      expect(srcCorpus()).toMatch(action)
    })
  }
})

// ── DB tables ─────────────────────────────────────────────────────────────────

describe('Runbook DB table references exist in source', () => {
  const tables = [
    'webhook_dead_letters',
    'webhook_delivery_attempts',
    'webhook_breaker_states',
    'org_webhook_egress_allowlist',
  ]

  for (const table of tables) {
    it(`table "${table}" is referenced in runbook`, () => {
      expect(runbook).toMatch(table)
    })

    it(`table "${table}" is queried in source`, () => {
      expect(srcCorpus()).toMatch(table)
    })
  }
})

/**
 * docs.runbookHorizon.test.ts
 *
 * Drift guard: asserts that every endpoint path, metric field, DB table, and
 * log event name referenced in docs/runbooks/horizon-stall.md exists somewhere
 * in the source tree.  If a name is renamed in code without updating the
 * runbook, or vice-versa, one of these tests will fail.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// ── Helpers ──────────────────────────────────────────────────────────────────

// Jest is invoked from the project root, so process.cwd() is the repo root.
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

const runbook = readFile('docs/runbooks/horizon-stall.md')

// ── Runbook file existence ────────────────────────────────────────────────────

describe('docs/runbooks/horizon-stall.md', () => {
  it('exists', () => {
    expect(runbook.length).toBeGreaterThan(0)
  })

  it('is cross-linked from docs/horizon-listener.md', () => {
    const horizonListenerDoc = readFile('docs/horizon-listener.md')
    expect(horizonListenerDoc).toMatch('runbooks/horizon-stall.md')
  })

  it('is cross-linked from docs/operations.md', () => {
    const operationsDoc = readFile('docs/operations.md')
    expect(operationsDoc).toMatch('runbooks/horizon-stall.md')
  })
})

// ── Admin endpoints ───────────────────────────────────────────────────────────

describe('Runbook endpoint references exist in source', () => {
  const endpoints = [
    '/api/health/deep',
    '/api/admin/horizon/listener',
    '/api/admin/horizon/listener/reset-cursor',
    '/api/admin/audit-logs',
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

describe('Runbook metric field references exist in source', () => {
  // camelCase field names emitted by GET /api/admin/horizon/listener and /api/health/deep
  const fields = ['lag', 'heartbeatAgeMs', 'lastProcessedLedger', 'timeSinceLastEventMs']

  for (const field of fields) {
    it(`field "${field}" is referenced in runbook`, () => {
      expect(runbook).toMatch(field)
    })

    it(`field "${field}" is present in source`, () => {
      expect(srcCorpus()).toMatch(field)
    })
  }
})

// ── Log event names ───────────────────────────────────────────────────────────

describe('Runbook log event references exist in source', () => {
  const logEvents = [
    'horizon.connection_error',
    'horizon.stream_error',
    'horizon.event_processing_failed',
    'horizon.event_parse_failed',
  ]

  for (const event of logEvents) {
    it(`log event "${event}" is referenced in runbook`, () => {
      expect(runbook).toMatch(event)
    })

    it(`log event "${event}" is emitted in source`, () => {
      expect(srcCorpus()).toMatch(event)
    })
  }
})

// ── Audit action name ────────────────────────────────────────────────────────

describe('Runbook audit action reference exists in source', () => {
  const action = 'horizon.listener.cursor_reset'

  it(`audit action "${action}" is referenced in runbook`, () => {
    expect(runbook).toMatch(action)
  })

  it(`audit action "${action}" is used in source`, () => {
    expect(srcCorpus()).toMatch(action)
  })
})

// ── DB table names ────────────────────────────────────────────────────────────

describe('Runbook DB table references exist in source', () => {
  const tables = [
    'listener_state',
    'horizon_checkpoints',
    'processed_events',
    'vaults',
    'scheduler_heartbeats',
    'audit_logs',
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

/**
 * docs.jobsdeadletters.test.ts
 *
 * Drift guard for docs/runbooks/jobs-dead-letters.md (issue #1861).
 *
 * Asserts the required runbook sections are present, that the runbook is linked
 * from docs/operations.md, and that every endpoint path, DB table and audit
 * action cited by the runbook still exists in the source tree. If a name is
 * renamed in code without updating the runbook, one of these tests fails.
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

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

const RUNBOOK_PATH = 'docs/runbooks/jobs-dead-letters.md'
const runbook = readFile(RUNBOOK_PATH)
const jobsRouterSource = readFile('src/routes/jobs.ts')

// ── Runbook file existence and linking ───────────────────────────────────────

describe(RUNBOOK_PATH, () => {
  it('exists', () => {
    expect(runbook.length).toBeGreaterThan(0)
  })

  it('is cross-linked from docs/operations.md', () => {
    expect(readFile('docs/operations.md')).toMatch('runbooks/jobs-dead-letters.md')
  })

  it('is cross-linked from docs/jobs.md', () => {
    expect(readFile('docs/jobs.md')).toMatch(/jobs-dead-letters\.md|runbooks/)
  })
})

// ── Required sections ────────────────────────────────────────────────────────

describe('Runbook has the required operational sections', () => {
  const requiredHeadings: Array<[string, RegExp]> = [
    ['severity', /^\*\*Severity:/m],
    ['owner', /^\*\*Owner:/m],
    ['related docs', /^\*\*Related docs:/m],
    ['symptoms', /^## .*Symptoms/im],
    ['diagnosis', /^## .*Diagnosis/im],
    ['remediation', /^## .*Remediation/im],
    ['rollback', /^## .*Rollback/im],
    ['escalation', /^## .*Escalation/im],
    ['post-incident checklist', /^## .*Post-incident Checklist/im],
  ]

  for (const [name, pattern] of requiredHeadings) {
    it(`includes the ${name} section`, () => {
      expect(runbook).toMatch(pattern)
    })
  }
})

// ── Job endpoints ────────────────────────────────────────────────────────────

describe('Runbook job endpoint references exist in the jobs router', () => {
  // [runbook path, router registration pattern in src/routes/jobs.ts]
  const endpoints: Array<[string, RegExp]> = [
    ['/api/jobs/health', /\.get\('\/health'/],
    ['/api/jobs/metrics', /\.get\('\/metrics'/],
    ['/api/jobs/depth', /\.get\('\/depth'/],
    ['/api/jobs/deadletters', /\.get\('\/deadletters'/],
    ['/api/jobs/deadletters/:id', /\.get\('\/deadletters\/:id'/],
    ['/api/jobs/deadletters/:id/replay', /\.post\('\/deadletters\/:id\/replay'/],
    ['/api/jobs/:id/retry', /\.post\('\/:id\/retry'/],
    ['/api/jobs/sweep', /\.post\('\/sweep'/],
    ['/api/jobs/enqueue', /\.post\('\/enqueue'/],
  ]

  it('the router is mounted at /api/jobs', () => {
    expect(readFile('src/app-bootstrap.ts')).toMatch("'/api/jobs'")
  })

  for (const [endpoint, registration] of endpoints) {
    it(`endpoint "${endpoint}" is referenced in runbook`, () => {
      expect(runbook).toMatch(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    })

    it(`endpoint "${endpoint}" is registered in src/routes/jobs.ts`, () => {
      expect(jobsRouterSource).toMatch(registration)
    })
  }

  it('references the deep-health endpoint', () => {
    expect(runbook).toMatch('/api/health/deep')
    expect(srcCorpus()).toMatch('/deep')
  })
})

// ── Metric / response field names ────────────────────────────────────────────

describe('Runbook metric and response fields exist in source', () => {
  const fields = [
    'queueDepth',
    'activeJobs',
    'delayedJobs',
    'deadLetterJobs',
    'totalDepth',
    'stuckActive',
    'recentFailures',
    'failureRate',
  ]

  for (const field of fields) {
    it(`field "${field}" is referenced in runbook`, () => {
      expect(runbook).toMatch(field)
    })

    it(`field "${field}" is present in source`, () => {
      expect(srcCorpus()).toMatch(field)
    })
  }
})

// ── Audit actions ────────────────────────────────────────────────────────────

describe('Runbook audit actions exist in source', () => {
  const actions = ['job.sweep', 'job.deadletter.replay', 'job.retry', 'job.enqueue']

  for (const action of actions) {
    it(`audit action "${action}" is referenced in runbook`, () => {
      expect(runbook).toMatch(action)
    })

    it(`audit action "${action}" is written by the jobs router`, () => {
      expect(jobsRouterSource).toMatch(action)
    })
  }
})

// ── DB table names ───────────────────────────────────────────────────────────

describe('Runbook DB table references exist in source', () => {
  const tables = ['audit_logs', 'scheduler_heartbeats', 'export_jobs', 'export_dlq_entries']

  for (const table of tables) {
    it(`table "${table}" is referenced in runbook`, () => {
      expect(runbook).toMatch(table)
    })

    it(`table "${table}" is queried in source`, () => {
      expect(srcCorpus()).toMatch(table)
    })
  }
})

// ── Environment variables ────────────────────────────────────────────────────

describe('Runbook environment variables exist in source', () => {
  const envVars = [
    'JOB_WORKER_CONCURRENCY',
    'JOB_QUEUE_POLL_INTERVAL_MS',
    'JOB_STALE_LEASE_MS',
    'JOB_HISTORY_LIMIT',
    'ENABLE_JOB_SCHEDULER',
  ]

  for (const envVar of envVars) {
    it(`env var "${envVar}" is referenced in runbook`, () => {
      expect(runbook).toMatch(envVar)
    })

    it(`env var "${envVar}" is read in source`, () => {
      expect(srcCorpus()).toMatch(envVar)
    })
  }
})

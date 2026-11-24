/**
 * Drift guard for the persisted export DLQ runbook.
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()

function readFile(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

function collectTs(dir: string): string[] {
  const abs = join(ROOT, dir)
  const entries = readdirSync(abs, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...collectTs(`${dir}/${entry.name}`))
    } else if (entry.name.endsWith('.ts')) {
      files.push(`${dir}/${entry.name}`)
    }
  }
  return files
}

const RUNBOOK_PATH = 'docs/runbooks/export-dlq.md'
const runbook = readFile(RUNBOOK_PATH)
const exportRouter = readFile('src/routes/exports.ts')
const exportService = readFile('src/services/exportQueue.ts')
const appBootstrap = readFile('src/app-bootstrap.ts')

let sourceCorpus: string | undefined
function srcCorpus(): string {
  if (!sourceCorpus) sourceCorpus = collectTs('src').map(readFile).join('\n')
  return sourceCorpus
}

describe(RUNBOOK_PATH, () => {
  it('exists and is linked from operations', () => {
    expect(runbook.length).toBeGreaterThan(0)
    expect(readFile('docs/operations.md')).toMatch('runbooks/export-dlq.md')
  })

  it('contains the required operational sections', () => {
    const headings: RegExp[] = [
      /^\*\*Severity:/m,
      /^\*\*Owner:/m,
      /^\*\*Related docs:/m,
      /^## Symptoms/im,
      /^## Diagnosis/im,
      /^## Remediation/im,
      /^## Rollback/im,
      /^## Escalation/im,
      /^## Post-incident Checklist/im,
    ]
    for (const heading of headings) expect(runbook).toMatch(heading)
  })

  it('references the real status and health endpoints', () => {
    expect(runbook).toMatch('/api/exports/status/')
    expect(exportRouter).toMatch(/router\.get\('\/status\/:jobId'/)
    expect(appBootstrap).toMatch("'/api/exports'")
    expect(runbook).toMatch('/api/health/deep')
    expect(srcCorpus()).toMatch(/\/deep/)
  })

  it('references persisted tables and service operations', () => {
    for (const table of ['export_dlq_entries', 'export_jobs']) {
      expect(runbook).toMatch(table)
      expect(srcCorpus()).toMatch(table)
    }
    for (const operation of [
      'getDlqEntries',
      'getDlqEntry',
      'getDlqDepth',
      'requeueDlqEntry',
      'recoverPendingExportJobs',
    ]) {
      expect(runbook).toMatch(operation)
      expect(exportService).toMatch(operation)
    }
  })

  it('documents the failure classifications and lack of an HTTP replay route', () => {
    for (const reason of ['serialization_error', 'data_fetch_error', 'unknown_error']) {
      expect(runbook).toMatch(reason)
      expect(exportService).toMatch(reason)
    }
    expect(runbook).toMatch(/no HTTP endpoint/i)
    expect(exportRouter).not.toMatch(/\/dlq|requeueDlqEntry/)
  })
})

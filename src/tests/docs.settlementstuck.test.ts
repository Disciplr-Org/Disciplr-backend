import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const readFile = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const runbook = readFile('docs/runbooks/settlement-stuck.md')
const jobsRouter = readFile('src/routes/jobs.ts')

describe('docs/runbooks/settlement-stuck.md', () => {
  it('exists and is linked from the operations guide', () => {
    expect(runbook.length).toBeGreaterThan(0)
    expect(readFile('docs/operations.md')).toContain('runbooks/settlement-stuck.md')
  })

  it.each([
    ['severity', /^\*\*Severity:/m],
    ['owner', /^\*\*Owner:/m],
    ['related docs', /^\*\*Related docs:/m],
    ['symptoms', /^## Symptoms/im],
    ['diagnosis', /^## Diagnosis/im],
    ['remediation', /^## Remediation/im],
    ['rollback', /^## Rollback/im],
    ['escalation', /^## Escalation/im],
    ['post-incident checklist', /^## Post-incident Checklist/im],
  ])('includes the required %s heading', (_name, pattern) => {
    expect(runbook).toMatch(pattern)
  })

  it.each([
    ['/api/jobs/health', /\.get\('\/health'/],
    ['/api/jobs/metrics', /\.get\('\/metrics'/],
    ['/api/jobs/deadletters', /\.get\('\/deadletters'/],
    ['/api/jobs/deadletters/:id/replay', /\.post\('\/deadletters\/:id\/replay'/],
    ['/api/jobs/enqueue', /\.post\('\/enqueue'/],
  ])('references registered endpoint %s', (endpoint, registration) => {
    expect(runbook).toContain(endpoint)
    expect(jobsRouter).toMatch(registration)
  })

  it('references the settlement table and processing job from source', () => {
    expect(runbook).toContain('settlement_operations')
    expect(readFile('src/services/settlementOperations.ts')).toContain('settlement_operations')
    expect(readFile('src/jobs/handlers.ts')).toContain("'settlement.process'")
  })
})

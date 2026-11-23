import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const runbook = readFileSync(join(ROOT, 'docs/runbooks/secret-rotation.md'), 'utf8')

describe('docs/runbooks/secret-rotation.md', () => {
  it('exists and has the operational runbook sections', () => {
    expect(runbook.length).toBeGreaterThan(0)
    for (const heading of [
      '## Symptoms',
      '## 1. Diagnosis',
      '## 2. Remediation',
      '## 3. Rollback',
      '## 4. Escalation',
      '## 5. Post-incident checklist',
    ]) {
      expect(runbook).toContain(heading)
    }
  })

  it('is linked from the operations guide', () => {
    const operationsDoc = readFileSync(join(ROOT, 'docs/operations.md'), 'utf8')
    expect(operationsDoc).toContain('runbooks/secret-rotation.md')
  })
})

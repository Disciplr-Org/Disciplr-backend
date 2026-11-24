import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const bootstrapPath = resolve(process.cwd(), 'src/app-bootstrap.ts')
const versioningDocPath = resolve(process.cwd(), 'docs/API_VERSIONING.md')

describe('API versioning router documentation', () => {
  const bootstrap = readFileSync(bootstrapPath, 'utf8')
  const documentation = readFileSync(versioningDocPath, 'utf8')

  const mountedPrefixes = Array.from(
    bootstrap.matchAll(
      /mountVersionedRoute\(app,\s*'([^']+)',\s*'([^']+)'/g,
    ),
    (match) => [match[1], match[2]],
  )

  const documentedPrefixes = documentation
    .split('\n')
    .filter((line) => line.startsWith('| `/api'))
    .map((line) => {
      const columns = line.split('|').map((column) => column.trim())
      return [
        columns[1].replaceAll('`', ''),
        columns[2].replaceAll('`', ''),
      ]
    })

  it('documents every mounted legacy and versioned prefix in mount order', () => {
    expect(documentedPrefixes).toEqual(mountedPrefixes)
  })

  it('includes a router file and authentication requirement for every mount', () => {
    const routerRows = documentation
      .split('\n')
      .filter((line) => line.startsWith('| `/api'))

    expect(routerRows).toHaveLength(mountedPrefixes.length)

    for (const row of routerRows) {
      const columns = row.split('|').map((column) => column.trim())
      expect(columns[3]).toMatch(/^\`src\/routes\/.+\.ts\`$/)
      expect(columns[4].length).toBeGreaterThan(0)
    }
  })
})

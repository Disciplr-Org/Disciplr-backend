import { generateOpenApiSpec } from '../docs/openapi-generator.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe('OpenAPI Generation', () => {
  it('generates a valid OpenAPI spec without errors', () => {
    expect(() => {
      const spec = generateOpenApiSpec()
      expect(spec).toBeDefined()
      expect(spec.openapi).toBe('3.1.0')
      expect(spec.info.title).toBe('Disciplr API')
    }).not.toThrow()
  })

  it('includes Jobs routes', () => {
    const spec = generateOpenApiSpec()
    const paths = spec.paths || {}
    
    expect(paths['/api/jobs/enqueue']).toBeDefined()
    expect(paths['/api/jobs/metrics']).toBeDefined()
    expect(paths['/api/jobs/deadletters']).toBeDefined()
    expect(paths['/api/jobs/health']).toBeDefined()
  })

  it('includes Transactions routes', () => {
    const spec = generateOpenApiSpec()
    const paths = spec.paths || {}
    
    expect(paths['/api/transactions']).toBeDefined()
    expect(paths['/api/transactions/{id}']).toBeDefined()
    expect(paths['/api/transactions/vault/{vaultId}']).toBeDefined()
  })

  it('includes Analytics routes', () => {
    const spec = generateOpenApiSpec()
    const paths = spec.paths || {}
    
    expect(paths['/api/analytics/summary']).toBeDefined()
    expect(paths['/api/analytics/vaults']).toBeDefined()
    expect(paths['/api/analytics/milestones/trends']).toBeDefined()
    expect(paths['/api/analytics/behavior']).toBeDefined()
  })

  it('includes Admin routes', () => {
    const spec = generateOpenApiSpec()
    const paths = spec.paths || {}
    
    expect(paths['/api/admin/users']).toBeDefined()
    expect(paths['/api/admin/audit-logs']).toBeDefined()
    expect(paths['/api/admin/db/metrics']).toBeDefined()
    expect(paths['/api/admin/overrides/vaults/{id}/cancel']).toBeDefined()
  })

  it('can write to openapi.yaml without errors', () => {
    const spec = generateOpenApiSpec()
    const yamlContent = require('yaml').stringify(spec)
    
    expect(yamlContent).toBeDefined()
    expect(yamlContent.length).toBeGreaterThan(100)
  })
})
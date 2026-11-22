import { describe, expect, it } from '@jest/globals'
import { generateOpenApiSpec } from '../docs/openapi-generator.js'

const spec = generateOpenApiSpec()
const paths = spec.paths ?? {}

const ORG_VAULT_PATHS = [
  '/api/organizations/{orgId}/vaults',
  '/api/organizations/{orgId}/vaults/search',
  '/api/organizations/{orgId}/vault-searches',
  '/api/organizations/{orgId}/vault-searches/{searchId}',
]

const ORG_ANALYTICS_PATHS = [
  '/api/orgs/{orgId}/analytics',
  '/api/orgs/{orgId}/analytics/risk',
  '/api/orgs/{orgId}/analytics/reports',
  '/api/orgs/{orgId}/cohort-retention',
  '/api/orgs/{orgId}/teams/rollup',
]

describe('OpenAPI org vault and analytics paths', () => {
  it.each(ORG_VAULT_PATHS)('documents %s', (path) => {
    expect(paths[path]).toBeDefined()
  })

  it.each(ORG_ANALYTICS_PATHS)('documents %s', (path) => {
    expect(paths[path]).toBeDefined()
  })

  it('documents the saved-search CRUD methods', () => {
    expect(Object.keys(paths['/api/organizations/{orgId}/vault-searches'] ?? {})).toEqual(
      expect.arrayContaining(['get', 'post']),
    )
    expect(
      Object.keys(paths['/api/organizations/{orgId}/vault-searches/{searchId}'] ?? {}),
    ).toEqual(expect.arrayContaining(['get', 'delete']))
  })

  it('requires bearer auth on every org vault and analytics path', () => {
    for (const path of [...ORG_VAULT_PATHS, ...ORG_ANALYTICS_PATHS]) {
      for (const operation of Object.values(paths[path] ?? {})) {
        expect(operation.security).toEqual([{ bearerAuth: [] }])
      }
    }
  })
})

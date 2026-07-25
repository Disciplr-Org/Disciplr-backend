import { jest } from '@jest/globals'
import knex, { Knex } from 'knex'

let testDb: Knex

const dbProxy: any = new Proxy(
  function () {} as any,
  {
    apply(_target: any, _this: any, args: any[]) {
      return (testDb as any)(...args)
    },
    get(_target: any, prop: string) {
      return (testDb as any)[prop]
    },
  },
)

jest.mock('../db/knex', () => ({
  db: dbProxy,
  closeDatabase: async () => {},
}))

import {
  clearCache,
  getFeatureFlagBucket,
  getFlag,
  matchesFeatureFlagRule,
} from '../services/featureFlags'

describe('feature flag rollout targeting', () => {
  beforeAll(async () => {
    testDb = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true })
    await testDb.schema.createTable('feature_flags', (t) => {
      t.string('name', 128).notNullable()
      t.string('org_id', 255).nullable()
      t.boolean('enabled').notNullable().defaultTo(false)
      t.decimal('rollout_percentage', 5, 2).nullable()
      t.json('rules').nullable()
      t.timestamp('updated_at').notNullable().defaultTo(testDb.fn.now())
    })
  })

  afterAll(async () => {
    await testDb.destroy()
  })

  beforeEach(async () => {
    clearCache()
    await testDb('feature_flags').del()
  })

  afterEach(() => {
    clearCache()
  })

  it('uses a stable bucket for the same flag and organization', () => {
    const first = getFeatureFlagBucket('ADVANCED_ANALYTICS', 'org-123')
    const second = getFeatureFlagBucket('ADVANCED_ANALYTICS', 'org-123')

    expect(first).toBe(second)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(100)
  })

  it('distributes percentage rollout within tolerance', () => {
    const enabled = Array.from({ length: 1000 }, (_, index) => `org-${index}`)
      .filter((orgId) => getFeatureFlagBucket('ADVANCED_ANALYTICS', orgId) < 20)

    expect(enabled.length).toBeGreaterThanOrEqual(160)
    expect(enabled.length).toBeLessThanOrEqual(240)
  })

  it('enables organizations inside the configured percentage rollout', async () => {
    await testDb('feature_flags').insert({
      name: 'ADVANCED_ANALYTICS',
      org_id: null,
      enabled: false,
      rollout_percentage: 20,
    })

    const insideOrg = Array.from({ length: 1000 }, (_, index) => `org-${index}`)
      .find((orgId) => getFeatureFlagBucket('ADVANCED_ANALYTICS', orgId) < 20)
    const outsideOrg = Array.from({ length: 1000 }, (_, index) => `org-${index}`)
      .find((orgId) => getFeatureFlagBucket('ADVANCED_ANALYTICS', orgId) >= 20)

    expect(await getFlag('ADVANCED_ANALYTICS', insideOrg!, { plan: 'free' })).toBe(true)
    expect(await getFlag('ADVANCED_ANALYTICS', outsideOrg!, { plan: 'free' })).toBe(false)
  })

  it('evaluates attribute targeting rules before percentage rollout', async () => {
    await testDb('feature_flags').insert({
      name: 'ENTERPRISE_ANALYTICS',
      org_id: null,
      enabled: false,
      rollout_percentage: 0,
      rules: JSON.stringify([
        { attribute: 'plan', operator: 'eq', value: 'enterprise', enabled: true },
      ]),
    })

    expect(matchesFeatureFlagRule(
      { attribute: 'plan', operator: 'eq', value: 'enterprise' },
      { plan: 'enterprise' },
    )).toBe(true)
    expect(await getFlag('ENTERPRISE_ANALYTICS', 'org-enterprise', { plan: 'enterprise' })).toBe(true)
    expect(await getFlag('ENTERPRISE_ANALYTICS', 'org-free', { plan: 'free' })).toBe(false)
  })

  it('lets explicit org allow and deny override global rules and rollout', async () => {
    await testDb('feature_flags').insert([
      {
        name: 'ORGANIZATION_QUOTAS',
        org_id: null,
        enabled: false,
        rollout_percentage: 100,
        rules: JSON.stringify([
          { attribute: 'plan', operator: 'eq', value: 'enterprise', enabled: true },
        ]),
      },
      {
        name: 'ORGANIZATION_QUOTAS',
        org_id: 'org-deny',
        enabled: false,
      },
      {
        name: 'ORGANIZATION_QUOTAS',
        org_id: 'org-allow',
        enabled: true,
      },
    ])

    expect(await getFlag('ORGANIZATION_QUOTAS', 'org-deny', { plan: 'enterprise' })).toBe(false)
    expect(await getFlag('ORGANIZATION_QUOTAS', 'org-allow', { plan: 'free' })).toBe(true)
  })
})

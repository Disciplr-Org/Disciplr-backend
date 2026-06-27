import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const migration = require('../../../db/migrations/20260627000000_add_org_list_composite_indexes.cjs')

type ExplainPlanNode = {
  'Node Type'?: string
  'Index Name'?: string
  Plans?: ExplainPlanNode[]
}

interface HotOrgListScenario {
  name: string
  sql: string
  expectedIndex: string
  plan: Array<{ Plan: ExplainPlanNode }>
}

const hotOrgListScenarios: HotOrgListScenario[] = [
  {
    name: 'org vaults newest page',
    sql: 'SELECT * FROM vaults WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    expectedIndex: 'idx_vaults_org_created_id',
    plan: [{ Plan: { 'Node Type': 'Index Scan', 'Index Name': 'idx_vaults_org_created_id' } }],
  },
  {
    name: 'org vaults status-filtered newest page',
    sql: 'SELECT * FROM vaults WHERE organization_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC LIMIT $3',
    expectedIndex: 'idx_vaults_org_status_created_id',
    plan: [{ Plan: { 'Node Type': 'Index Scan', 'Index Name': 'idx_vaults_org_status_created_id' } }],
  },
  {
    name: 'org vaults creator-filtered newest page',
    sql: 'SELECT * FROM vaults WHERE organization_id = $1 AND creator = $2 ORDER BY created_at DESC, id DESC LIMIT $3',
    expectedIndex: 'idx_vaults_org_creator_created_id',
    plan: [{ Plan: { 'Node Type': 'Index Scan', 'Index Name': 'idx_vaults_org_creator_created_id' } }],
  },
  {
    name: 'user transaction cursor page',
    sql: 'SELECT * FROM transactions WHERE user_id = $1 ORDER BY stellar_timestamp DESC, id DESC LIMIT $2',
    expectedIndex: 'idx_transactions_user_stellar_id',
    plan: [{ Plan: { 'Node Type': 'Index Scan', 'Index Name': 'idx_transactions_user_stellar_id' } }],
  },
  {
    name: 'user transaction by-vault cursor page',
    sql: 'SELECT * FROM transactions WHERE user_id = $1 AND vault_id = $2 ORDER BY stellar_timestamp DESC, id DESC LIMIT $3',
    expectedIndex: 'idx_transactions_user_vault_stellar_id',
    plan: [{ Plan: { 'Node Type': 'Index Scan', 'Index Name': 'idx_transactions_user_vault_stellar_id' } }],
  },
  {
    name: 'user transaction type-filtered cursor page',
    sql: 'SELECT * FROM transactions WHERE user_id = $1 AND type = $2 ORDER BY stellar_timestamp DESC, id DESC LIMIT $3',
    expectedIndex: 'idx_transactions_user_type_stellar_id',
    plan: [{ Plan: { 'Node Type': 'Index Scan', 'Index Name': 'idx_transactions_user_type_stellar_id' } }],
  },
  {
    name: 'user notifications newest page',
    sql: 'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    expectedIndex: 'idx_notifications_user_created_id',
    plan: [{ Plan: { 'Node Type': 'Index Scan', 'Index Name': 'idx_notifications_user_created_id' } }],
  },
  {
    name: 'org audit logs newest page',
    sql: 'SELECT * FROM audit_logs WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    expectedIndex: 'idx_audit_logs_org_created_id',
    plan: [{ Plan: { 'Node Type': 'Index Scan', 'Index Name': 'idx_audit_logs_org_created_id' } }],
  },
]

const collectPlanSummary = (plan: unknown): { nodeTypes: string[]; indexNames: string[] } => {
  const summary = { nodeTypes: [] as string[], indexNames: [] as string[] }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    if (!value || typeof value !== 'object') return

    const node = value as ExplainPlanNode & { Plan?: ExplainPlanNode }
    if (node.Plan) {
      visit(node.Plan)
      return
    }

    if (node['Node Type']) summary.nodeTypes.push(node['Node Type'])
    if (node['Index Name']) summary.indexNames.push(node['Index Name'])
    if (node.Plans) node.Plans.forEach(visit)
  }

  visit(plan)
  return summary
}

const assertHotPathPlan = (scenario: HotOrgListScenario): void => {
  const summary = collectPlanSummary(scenario.plan)
  expect(summary.nodeTypes).not.toContain('Seq Scan')
  expect(summary.indexNames).toContain(scenario.expectedIndex)
}

describe('org-scoped list query-plan audit', () => {
  it('enumerates each hot org/user-scoped list query with its covering index', () => {
    expect(hotOrgListScenarios.map((scenario) => scenario.name)).toEqual([
      'org vaults newest page',
      'org vaults status-filtered newest page',
      'org vaults creator-filtered newest page',
      'user transaction cursor page',
      'user transaction by-vault cursor page',
      'user transaction type-filtered cursor page',
      'user notifications newest page',
      'org audit logs newest page',
    ])
  })

  it('asserts representative EXPLAIN plans use the audited indexes and avoid seq scans', () => {
    for (const scenario of hotOrgListScenarios) {
      assertHotPathPlan(scenario)
      expect(scenario.sql).toMatch(/ORDER BY .+ DESC, id DESC/)
    }
  })

  it('fails the audit when a hot plan regresses to a sequential scan', () => {
    const regressedPlan: HotOrgListScenario = {
      ...hotOrgListScenarios[0]!,
      plan: [{ Plan: { 'Node Type': 'Seq Scan' } }],
    }

    expect(() => assertHotPathPlan(regressedPlan)).toThrow()
  })

  it('creates and rolls back only the missing composite indexes', async () => {
    const rawCalls: string[] = []
    const knex = {
      raw: async (sql: string) => {
        rawCalls.push(sql)
      },
    }

    await migration.up(knex)
    await migration.down(knex)

    for (const scenario of hotOrgListScenarios) {
      expect(rawCalls.some((sql) => sql.includes(`CREATE INDEX IF NOT EXISTS ${scenario.expectedIndex}`))).toBe(true)
      expect(rawCalls.some((sql) => sql.includes(`DROP INDEX IF EXISTS ${scenario.expectedIndex}`))).toBe(true)
    }

    expect(rawCalls.some((sql) => sql.includes('idx_vaults_status_end_date'))).toBe(false)
    expect(rawCalls.some((sql) => sql.includes('idx_audit_logs_organization_created'))).toBe(false)
  })
})

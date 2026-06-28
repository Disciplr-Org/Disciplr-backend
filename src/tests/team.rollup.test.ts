import { describe, it, expect, beforeEach } from '@jest/globals'
import { getTeamRollup } from '../services/team.js'

const ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

type RawResult = { rows: Record<string, string | number>[] } | Record<string, string | number>[]

function makeQueryRunner(rawResult: RawResult) {
  return {
    raw: async () => rawResult,
  }
}

describe('getTeamRollup', () => {
  let capturedSql: string | undefined
  let capturedBindings: unknown[] | undefined

  beforeEach(() => {
    capturedSql = undefined
    capturedBindings = undefined
  })

  function makeCapturingQueryRunner(rawResult: RawResult) {
    return {
      raw: async (sql: string, bindings: unknown[]) => {
        capturedSql = sql
        capturedBindings = bindings
        return rawResult
      },
    }
  }

  it('returns empty teams and zeroed orgTotals for org with zero teams', async () => {
    const result = await getTeamRollup(ORG_ID, makeQueryRunner({ rows: [] }))

    expect(result.orgId).toBe(ORG_ID)
    expect(result.teams).toEqual([])
    expect(result.orgTotals.teamCount).toBe(0)
    expect(result.orgTotals.vaultCount).toBe(0)
    expect(result.orgTotals.totalCapital).toBe('0')
    expect(result.orgTotals.activeVaults).toBe(0)
    expect(result.orgTotals.completedVaults).toBe(0)
    expect(result.orgTotals.failedVaults).toBe(0)
    expect(result.orgTotals.milestoneCount).toBe(0)
    expect(result.orgTotals.milestonesCompleted).toBe(0)
    expect(result.orgTotals.slashRate).toBe(0)
    expect(result.generatedAt).toBeDefined()
  })

  it('passes orgId as the only binding three times in the query', async () => {
    await getTeamRollup(ORG_ID, makeCapturingQueryRunner({ rows: [] }))

    expect(capturedBindings).toEqual([ORG_ID, ORG_ID, ORG_ID])
  })

  it('returns teams with all zeros for teams with no vaults or milestones', async () => {
    const result = await getTeamRollup(ORG_ID, makeQueryRunner({
      rows: [
        {
          team_id: 't1',
          name: 'Empty Team',
          slug: 'empty-team',
          vault_count: 0,
          total_capital: 0,
          active_vaults: 0,
          completed_vaults: 0,
          failed_vaults: 0,
          total_milestones: 0,
          completed_milestones: 0,
        },
        {
          team_id: 't2',
          name: 'Also Empty',
          slug: 'also-empty',
          vault_count: 0,
          total_capital: 0,
          active_vaults: 0,
          completed_vaults: 0,
          failed_vaults: 0,
          total_milestones: 0,
          completed_milestones: 0,
        },
      ],
    }))

    expect(result.teams).toHaveLength(2)
    for (const team of result.teams) {
      expect(team.vaultCount).toBe(0)
      expect(team.totalCapital).toBe('0')
      expect(team.activeVaults).toBe(0)
      expect(team.completedVaults).toBe(0)
      expect(team.failedVaults).toBe(0)
      expect(team.milestoneCount).toBe(0)
      expect(team.milestonesCompleted).toBe(0)
      expect(team.slashRate).toBe(0)
    }
    expect(result.orgTotals.teamCount).toBe(2)
    expect(result.orgTotals.vaultCount).toBe(0)
  })

  it('aggregates vault, capital, and milestone metrics across teams', async () => {
    const result = await getTeamRollup(ORG_ID, makeQueryRunner({
      rows: [
        {
          team_id: 't1',
          name: 'Alpha',
          slug: 'alpha',
          vault_count: 3,
          total_capital: 1500,
          active_vaults: 1,
          completed_vaults: 1,
          failed_vaults: 1,
          total_milestones: 6,
          completed_milestones: 4,
        },
        {
          team_id: 't2',
          name: 'Beta',
          slug: 'beta',
          vault_count: 2,
          total_capital: 500,
          active_vaults: 0,
          completed_vaults: 2,
          failed_vaults: 0,
          total_milestones: 4,
          completed_milestones: 2,
        },
      ],
    }))

    expect(result.teams).toHaveLength(2)

    const alpha = result.teams.find((t) => t.slug === 'alpha')!
    expect(alpha.vaultCount).toBe(3)
    expect(alpha.totalCapital).toBe('1500')
    expect(alpha.activeVaults).toBe(1)
    expect(alpha.completedVaults).toBe(1)
    expect(alpha.failedVaults).toBe(1)
    expect(alpha.milestoneCount).toBe(6)
    expect(alpha.milestonesCompleted).toBe(4)
    expect(alpha.slashRate).toBe(0.5)

    const beta = result.teams.find((t) => t.slug === 'beta')!
    expect(beta.slashRate).toBe(0)

    expect(result.orgTotals.teamCount).toBe(2)
    expect(result.orgTotals.vaultCount).toBe(5)
    expect(result.orgTotals.totalCapital).toBe('2000')
    expect(result.orgTotals.activeVaults).toBe(1)
    expect(result.orgTotals.completedVaults).toBe(3)
    expect(result.orgTotals.failedVaults).toBe(1)
    expect(result.orgTotals.milestoneCount).toBe(10)
    expect(result.orgTotals.milestonesCompleted).toBe(6)
    expect(result.orgTotals.slashRate).toBe(0.25)
  })

  it('deduplicates vaults shared across teams via ROW_NUMBER', async () => {
    const result = await getTeamRollup(ORG_ID, makeQueryRunner({
      rows: [
        {
          team_id: 't1',
          name: 'Team A',
          slug: 'team-a',
          vault_count: 1,
          total_capital: 1000,
          active_vaults: 1,
          completed_vaults: 0,
          failed_vaults: 0,
          total_milestones: 2,
          completed_milestones: 1,
        },
        {
          team_id: 't2',
          name: 'Team B',
          slug: 'team-b',
          vault_count: 0,
          total_capital: 0,
          active_vaults: 0,
          completed_vaults: 0,
          failed_vaults: 0,
          total_milestones: 0,
          completed_milestones: 0,
        },
      ],
    }))

    const teamA = result.teams.find((t) => t.slug === 'team-a')!
    expect(teamA.vaultCount).toBe(1)
    expect(teamA.totalCapital).toBe('1000')

    const teamB = result.teams.find((t) => t.slug === 'team-b')!
    expect(teamB.vaultCount).toBe(0)

    expect(result.orgTotals.vaultCount).toBe(1)
    expect(result.orgTotals.totalCapital).toBe('1000')
  })

  it('prevents cross-org leakage by scoping all CTEs to the provided orgId', async () => {
    await getTeamRollup(ORG_ID, makeCapturingQueryRunner({ rows: [] }))

    expect(capturedSql).toContain('m.organization_id = ?')
    expect(capturedSql).toContain('v.organization_id = ?')
    expect(capturedSql).toContain('t.organization_id = ?')
    expect(capturedBindings).toEqual([ORG_ID, ORG_ID, ORG_ID])
  })

  it('computes slashRate as failed / (completed + failed) per team', async () => {
    const result = await getTeamRollup(ORG_ID, makeQueryRunner({
      rows: [
        {
          team_id: 't1',
          name: 'High Slash',
          slug: 'high-slash',
          vault_count: 10,
          total_capital: 5000,
          active_vaults: 4,
          completed_vaults: 2,
          failed_vaults: 4,
          total_milestones: 0,
          completed_milestones: 0,
        },
        {
          team_id: 't2',
          name: 'No Resolved',
          slug: 'no-resolved',
          vault_count: 3,
          total_capital: 300,
          active_vaults: 3,
          completed_vaults: 0,
          failed_vaults: 0,
          total_milestones: 0,
          completed_milestones: 0,
        },
      ],
    }))

    const highSlash = result.teams.find((t) => t.slug === 'high-slash')!
    expect(highSlash.slashRate).toBe(0.6667)

    const noResolved = result.teams.find((t) => t.slug === 'no-resolved')!
    expect(noResolved.slashRate).toBe(0)

    expect(result.orgTotals.slashRate).toBe(0.6667)
  })

  it('includes generatedAt as a valid ISO timestamp', async () => {
    const result = await getTeamRollup(ORG_ID, makeQueryRunner({ rows: [] }))

    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt)
  })

  it('handles mixed teams where some have data and others are empty', async () => {
    const result = await getTeamRollup(ORG_ID, makeQueryRunner({
      rows: [
        {
          team_id: 't1',
          name: 'Active Team',
          slug: 'active-team',
          vault_count: 5,
          total_capital: 2500,
          active_vaults: 2,
          completed_vaults: 2,
          failed_vaults: 1,
          total_milestones: 8,
          completed_milestones: 5,
        },
        {
          team_id: 't2',
          name: 'Lazy Team',
          slug: 'lazy-team',
          vault_count: 0,
          total_capital: 0,
          active_vaults: 0,
          completed_vaults: 0,
          failed_vaults: 0,
          total_milestones: 0,
          completed_milestones: 0,
        },
      ],
    }))

    expect(result.teams).toHaveLength(2)
    expect(result.orgTotals.vaultCount).toBe(5)
    expect(result.orgTotals.totalCapital).toBe('2500')
    expect(result.orgTotals.milestoneCount).toBe(8)
    expect(result.orgTotals.milestonesCompleted).toBe(5)
  })

  it('handles db.raw returning array format (non-pg driver)', async () => {
    const row = {
      team_id: 't1',
      name: 'Team',
      slug: 'team',
      vault_count: 2,
      total_capital: 800,
      active_vaults: 1,
      completed_vaults: 1,
      failed_vaults: 0,
      total_milestones: 3,
      completed_milestones: 2,
    }
    const result = await getTeamRollup(ORG_ID, makeQueryRunner([row] as unknown as { rows: never }))

    expect(result.teams).toHaveLength(1)
    expect(result.teams[0].vaultCount).toBe(2)
  })
})

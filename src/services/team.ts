import db from '../db/index.js'
import type { Knex } from 'knex'
import type { Team, CreateTeamInput } from '../types/enterprise.js'

export const createTeam = async (input: CreateTeamInput): Promise<Team> => {
  const [team] = await db('teams')
    .insert({
      name: input.name,
      slug: input.slug,
      organization_id: input.organization_id,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .returning('*')
  return team
}

export const getTeamById = async (id: string): Promise<Team | null> => {
  return db('teams').where({ id }).first()
}

export const listTeamsByOrganization = async (organizationId: string): Promise<Team[]> => {
  return db('teams').where({ organization_id: organizationId }).select('*')
}

export interface TeamRollupEntry {
  teamId: string
  name: string
  slug: string
  vaultCount: number
  totalCapital: string
  activeVaults: number
  completedVaults: number
  failedVaults: number
  milestoneCount: number
  milestonesCompleted: number
  slashRate: number
}

export interface TeamRollupResult {
  orgId: string
  teams: TeamRollupEntry[]
  orgTotals: {
    teamCount: number
    vaultCount: number
    totalCapital: string
    activeVaults: number
    completedVaults: number
    failedVaults: number
    milestoneCount: number
    milestonesCompleted: number
    slashRate: number
  }
  generatedAt: string
}

type RollupRow = Record<string, string | number>

const ROLLUP_SQL = `WITH deduped_team_vaults AS (
  SELECT v.id AS vault_id,
         v.amount,
         v.status,
         m.team_id,
         ROW_NUMBER() OVER (PARTITION BY v.id ORDER BY m.team_id) AS rn
  FROM vaults v
  JOIN memberships m ON m.user_id = v.creator
    AND m.organization_id = ?
    AND m.team_id IS NOT NULL
  WHERE v.organization_id = ?
    AND v.deleted_at IS NULL
),
team_vault_stats AS (
  SELECT team_id,
         COUNT(*) AS vault_count,
         SUM(amount)::numeric AS total_capital,
         COUNT(*) FILTER (WHERE status = 'active') AS active_vaults,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed_vaults,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_vaults
  FROM deduped_team_vaults
  WHERE rn = 1
  GROUP BY team_id
),
deduped_team_milestones AS (
  SELECT ml.id AS milestone_id,
         ml.status AS milestone_status,
         dtv.team_id
  FROM milestones ml
  JOIN deduped_team_vaults dtv ON dtv.vault_id = ml.vault_id AND dtv.rn = 1
  WHERE ml.deleted_at IS NULL
),
team_milestone_stats AS (
  SELECT team_id,
         COUNT(*) AS total_milestones,
         COUNT(*) FILTER (WHERE milestone_status = 'approved') AS completed_milestones
  FROM deduped_team_milestones
  GROUP BY team_id
)
SELECT t.id AS team_id,
       t.name,
       t.slug,
       COALESCE(vs.vault_count, 0) AS vault_count,
       COALESCE(vs.total_capital, 0) AS total_capital,
       COALESCE(vs.active_vaults, 0) AS active_vaults,
       COALESCE(vs.completed_vaults, 0) AS completed_vaults,
       COALESCE(vs.failed_vaults, 0) AS failed_vaults,
       COALESCE(ms.total_milestones, 0) AS total_milestones,
       COALESCE(ms.completed_milestones, 0) AS completed_milestones
FROM teams t
LEFT JOIN team_vault_stats vs ON vs.team_id = t.id
LEFT JOIN team_milestone_stats ms ON ms.team_id = t.id
WHERE t.organization_id = ?
ORDER BY t.name`

export const getTeamRollup = async (
  orgId: string,
  queryRunner: Pick<Knex, 'raw'> = db,
): Promise<TeamRollupResult> => {
  const raw = await queryRunner.raw(ROLLUP_SQL, [orgId, orgId, orgId])

  const rows: RollupRow[] = (raw as { rows: RollupRow[] }).rows ?? (raw as RollupRow[])

  const teams: TeamRollupEntry[] = rows.map((r) => {
    const failed = Number(r.failed_vaults)
    const completed = Number(r.completed_vaults)
    const resolved = failed + completed
    return {
      teamId: String(r.team_id),
      name: String(r.name),
      slug: String(r.slug),
      vaultCount: Number(r.vault_count),
      totalCapital: Number(r.total_capital).toString(),
      activeVaults: Number(r.active_vaults),
      completedVaults: Number(r.completed_vaults),
      failedVaults: Number(r.failed_vaults),
      milestoneCount: Number(r.total_milestones),
      milestonesCompleted: Number(r.completed_milestones),
      slashRate: resolved > 0 ? Number((failed / resolved).toFixed(4)) : 0,
    }
  })

  const orgTotals = teams.reduce(
    (acc, t) => {
      acc.vaultCount += t.vaultCount
      acc.activeVaults += t.activeVaults
      acc.completedVaults += t.completedVaults
      acc.failedVaults += t.failedVaults
      acc.milestoneCount += t.milestoneCount
      acc.milestonesCompleted += t.milestonesCompleted
      acc.totalCapital = (Number(acc.totalCapital) + Number(t.totalCapital)).toString()
      return acc
    },
    {
      teamCount: teams.length,
      vaultCount: 0,
      totalCapital: '0',
      activeVaults: 0,
      completedVaults: 0,
      failedVaults: 0,
      milestoneCount: 0,
      milestonesCompleted: 0,
      slashRate: 0,
    } as TeamRollupResult['orgTotals'],
  )

  const orgResolved = orgTotals.completedVaults + orgTotals.failedVaults
  orgTotals.slashRate = orgResolved > 0
    ? Number((orgTotals.failedVaults / orgResolved).toFixed(4))
    : 0

  return {
    orgId,
    teams,
    orgTotals,
    generatedAt: new Date().toISOString(),
  }
}

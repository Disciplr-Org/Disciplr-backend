import { beforeEach, describe, expect, it, jest } from '@jest/globals'

type MembershipRow = {
  id: string
  user_id: string
  organization_id: string
  team_id: null
  role: string
}

type MembershipQuery = {
  where: (criteria: Partial<MembershipRow>) => MembershipQuery
  forUpdate: () => MembershipQuery
  first: () => Promise<MembershipRow | undefined>
  select: (column: string) => Promise<MembershipRow[]>
  update: (values: Partial<MembershipRow>) => MembershipQuery
  returning: (columns?: string | string[]) => Promise<MembershipRow[]>
}

type Transaction = (table: string) => MembershipQuery

let memberships: MembershipRow[] = []
const updates: Array<{
  criteria: Partial<MembershipRow>
  values: Partial<MembershipRow>
}> = []

const matches = (
  membership: MembershipRow,
  criteria: Partial<MembershipRow>,
): boolean => (
  (criteria.id === undefined || membership.id === criteria.id)
  && (criteria.user_id === undefined || membership.user_id === criteria.user_id)
  && (criteria.organization_id === undefined || membership.organization_id === criteria.organization_id)
  && (criteria.team_id === undefined || membership.team_id === criteria.team_id)
  && (criteria.role === undefined || membership.role === criteria.role)
)

const trx: Transaction = () => {
  let criteria: Partial<MembershipRow> = {}

  const query: MembershipQuery = {
    where: (nextCriteria) => {
      criteria = { ...criteria, ...nextCriteria }
      return query
    },
    forUpdate: () => query,
    first: async () => memberships.find((membership) => matches(membership, criteria)),
    select: async () => memberships.filter((membership) => matches(membership, criteria)),
    update: (values) => {
      updates.push({ criteria: { ...criteria }, values })
      memberships = memberships.map((membership) => (
        matches(membership, criteria) ? { ...membership, ...values } : membership
      ))
      return query
    },
    returning: async () => memberships.filter((membership) => matches(membership, criteria)),
  }

  return query
}

const createAuditLog = jest.fn()
const database = {
  transaction: jest.fn(async <T>(callback: (transaction: Transaction) => Promise<T>) => callback(trx)),
}

jest.unstable_mockModule('../db/index.js', () => ({ default: database }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog }))

const { changeRole, transferOwnership } = await import('../services/membership.js')

const membership = (userId: string, role: string): MembershipRow => ({
  id: userId,
  user_id: userId,
  organization_id: 'org-1',
  team_id: null,
  role,
})

describe('Membership Role Transitions', () => {
  beforeEach(() => {
    memberships = []
    updates.length = 0
    database.transaction.mockClear()
    createAuditLog.mockClear()
  })

  it('rejects demotion of the last owner', async () => {
    memberships = [membership('owner-1', 'owner')]

    await expect(changeRole('owner-1', 'org-1', 'admin', 'actor-1'))
      .rejects.toThrow('Cannot demote the last owner of an organization.')

    expect(updates).toHaveLength(0)
    expect(createAuditLog).not.toHaveBeenCalled()
  })

  it('transfers ownership by promoting the target and demoting the current owner', async () => {
    memberships = [
      membership('owner-1', 'owner'),
      membership('member-2', 'admin'),
    ]

    await transferOwnership('org-1', 'owner-1', 'member-2')

    expect(updates).toEqual([
      {
        criteria: { user_id: 'member-2', organization_id: 'org-1', team_id: null },
        values: { role: 'owner' },
      },
      {
        criteria: { user_id: 'owner-1', organization_id: 'org-1', team_id: null },
        values: { role: 'admin' },
      },
    ])
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actor_user_id: 'owner-1',
      action: 'org.ownership.transferred',
      metadata: expect.objectContaining({ from_user: 'owner-1', to_user: 'member-2' }),
    }))
  })

  it('treats reapplying the current role as a no-op', async () => {
    const currentMembership = membership('member-1', 'member')
    memberships = [currentMembership]

    await expect(changeRole('member-1', 'org-1', 'member', 'actor-1'))
      .resolves.toEqual(currentMembership)

    expect(updates).toHaveLength(0)
    expect(createAuditLog).not.toHaveBeenCalled()
  })

  it('rejects ownership transfer by a non-owner', async () => {
    memberships = [
      membership('admin-1', 'admin'),
      membership('member-2', 'member'),
    ]

    await expect(transferOwnership('org-1', 'admin-1', 'member-2'))
      .rejects.toThrow('Caller is not an owner.')

    expect(updates).toHaveLength(0)
    expect(createAuditLog).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, jest } from '@jest/globals'

const mockDb = jest.fn()

jest.unstable_mockModule('../db/index.js', () => ({ default: mockDb }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog: jest.fn() }))

const { listOrgMemberships } = await import('../services/membership.js')

describe('listOrgMemberships pagination', () => {
  it('limits and offsets the roster while returning the total count', async () => {
    const rows = [
      { id: 'member-3', organization_id: 'org-1', role: 'member' },
      { id: 'member-4', organization_id: 'org-1', role: 'member' },
    ]
    const membersQuery = {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockResolvedValue(rows),
    }
    const countQuery = {
      where: jest.fn().mockReturnThis(),
      count: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ count: '5' }),
    }
    mockDb.mockReset().mockReturnValueOnce(membersQuery).mockReturnValueOnce(countQuery)

    await expect(listOrgMemberships('org-1', { page: 2, pageSize: 2 })).resolves.toEqual({
      members: rows,
      total: 5,
      page: 2,
      pageSize: 2,
    })
    expect(membersQuery.limit).toHaveBeenCalledWith(2)
    expect(membersQuery.offset).toHaveBeenCalledWith(2)
    expect(membersQuery.orderBy).toHaveBeenCalledWith('created_at', 'asc')
  })
})

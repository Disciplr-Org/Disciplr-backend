/**
 * Regression tests for #1386 / #1253:
 * VaultService SQL must target the migrated vaults schema
 * (creator, verifier, start_date, end_date) — never the stale
 * contract_id / creator_address / milestone_hash / verifier_address / deadline names.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { VaultStatus } from '../types/vault.js'

const mockQuery = jest.fn<any>()

jest.unstable_mockModule('../db/index.js', () => ({
  pool: { query: mockQuery },
  db: jest.fn<any>(() => ({
    where: jest.fn<any>().mockReturnThis(),
    select: jest.fn<any>().mockResolvedValue([]),
  })),
  default: jest.fn<any>(() => ({})),
}))

const { VaultService } = await import('../services/vault.service.js')

const FORBIDDEN_COLUMNS = [
  'creator_address',
  'verifier_address',
  'milestone_hash',
  'contract_id',
  'deadline',
] as const

const REQUIRED_CREATE_COLUMNS = [
  'creator',
  'amount',
  'start_date',
  'end_date',
  'verifier',
  'success_destination',
  'failure_destination',
  'status',
] as const

const createDto = {
  id: 'vault-schema-1',
  creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  amount: '100.0000000',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-12-31T00:00:00.000Z',
  verifier: 'GVERIFIERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  status: VaultStatus.DRAFT,
}

function assertNoForbiddenColumns(sql: string) {
  const normalized = sql.toLowerCase()
  for (const col of FORBIDDEN_COLUMNS) {
    expect(normalized).not.toContain(col)
  }
}

describe('VaultService schema alignment (#1386)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('createVault INSERT uses migrated column names only', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: createDto.id,
          creator: createDto.creator,
          amount: createDto.amount,
          start_date: createDto.startDate,
          end_date: createDto.endDate,
          verifier: createDto.verifier,
          success_destination: createDto.successDestination,
          failure_destination: createDto.failureDestination,
          status: VaultStatus.DRAFT,
        },
      ],
    })

    const result = await VaultService.createVault(createDto)

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]

    assertNoForbiddenColumns(sql)
    for (const col of REQUIRED_CREATE_COLUMNS) {
      expect(sql.toLowerCase()).toContain(col)
    }
    expect(sql).toMatch(/INSERT\s+INTO\s+vaults/i)
    expect(sql).toMatch(/RETURNING\s+\*/i)

    expect(values).toEqual([
      createDto.id,
      createDto.creator,
      createDto.amount,
      createDto.startDate,
      createDto.endDate,
      createDto.verifier,
      createDto.successDestination,
      createDto.failureDestination,
      VaultStatus.DRAFT,
    ])
    expect(result.id).toBe(createDto.id)
    expect(result.creator).toBe(createDto.creator)
  })

  it('getVaultById selects by id without stale column names', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'vault-2', creator: 'GADDR', status: VaultStatus.ACTIVE }],
    })

    const vault = await VaultService.getVaultById('vault-2')

    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    assertNoForbiddenColumns(sql)
    expect(sql).toMatch(/SELECT\s+\*\s+FROM\s+vaults\s+WHERE\s+id\s*=\s*\$1/i)
    expect(values).toEqual(['vault-2'])
    expect(vault?.id).toBe('vault-2')
  })

  it('getVaultById returns null when no row exists', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await expect(VaultService.getVaultById('missing')).resolves.toBeNull()
  })

  it('updateVaultStatus updates status and updated_at', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    await VaultService.updateVaultStatus('vault-3', 'cancelled')

    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    assertNoForbiddenColumns(sql)
    expect(sql.toLowerCase()).toContain('update vaults')
    expect(sql.toLowerCase()).toContain('status')
    expect(sql.toLowerCase()).toContain('updated_at')
    expect(values).toEqual(['cancelled', 'vault-3'])
  })

  it('getVaultsByUser filters on creator (not creator_address)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'v1', creator: 'GUSER' },
        { id: 'v2', creator: 'GUSER' },
      ],
    })

    const vaults = await VaultService.getVaultsByUser('GUSER')

    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    assertNoForbiddenColumns(sql)
    expect(sql.toLowerCase()).toContain('where creator =')
    expect(sql.toLowerCase()).not.toContain('creator_address')
    expect(values).toEqual(['GUSER'])
    expect(vaults).toHaveLength(2)
  })
})

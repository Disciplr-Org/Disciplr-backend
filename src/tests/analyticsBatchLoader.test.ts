import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type {
  DbLike,
  MilestoneAggregate,
  VaultAggregate,
} from '../services/analyticsBatchLoader.js'

const defaultQuery = jest.fn<DbLike['query']>()

jest.unstable_mockModule('../db/database.js', () => ({
  db: { query: defaultQuery },
}))

const {
  AnalyticsBatchLoader,
  createAnalyticsBatchLoader,
  getOrgAnalyticsBatched,
} = await import('../services/analyticsBatchLoader.js')

const vaultRow = (overrides: Partial<VaultAggregate> = {}): VaultAggregate => ({
  vaultId: 'vault-1',
  status: 'active',
  amount: '100',
  milestoneCount: 2,
  completedMilestones: 1,
  ...overrides,
})

const milestoneRow = (
  overrides: Partial<MilestoneAggregate> = {},
): MilestoneAggregate => ({
  vaultId: 'vault-1',
  milestoneCount: 3,
  completedMilestones: 1,
  pendingMilestones: 2,
  ...overrides,
})

function makeDb(query: DbLike['query']): DbLike {
  return { query }
}

describe('AnalyticsBatchLoader.loadVaults', () => {
  it('batches unique IDs and converts aggregate counts to numbers', async () => {
    const query = jest.fn<DbLike['query']>().mockResolvedValue({
      rows: [
        { ...vaultRow(), milestoneCount: '3', completedMilestones: '2' },
        {
          ...vaultRow({ vaultId: 'vault-2', amount: '250', status: 'completed' }),
          milestoneCount: '0',
          completedMilestones: '0',
        },
      ],
    })
    const loader = new AnalyticsBatchLoader(makeDb(query))

    const result = await loader.loadVaults(['vault-1', 'vault-2', 'vault-1'])

    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE v.id IN ($1,$2)'),
      ['vault-1', 'vault-2'],
    )
    expect(result).toEqual(new Map([
      ['vault-1', vaultRow({ milestoneCount: 3, completedMilestones: 2 })],
      ['vault-2', vaultRow({
        vaultId: 'vault-2',
        amount: '250',
        status: 'completed',
        milestoneCount: 0,
        completedMilestones: 0,
      })],
    ]))
    expect(loader.queries).toBe(1)
  })

  it('caches loaded vaults and queries only newly requested IDs', async () => {
    const query = jest.fn<DbLike['query']>()
      .mockResolvedValueOnce({ rows: [vaultRow()] })
      .mockResolvedValueOnce({ rows: [vaultRow({ vaultId: 'vault-2' })] })
    const loader = new AnalyticsBatchLoader(makeDb(query))

    await loader.loadVaults(['vault-1'])
    const result = await loader.loadVaults(['vault-1', 'vault-2'])

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1][1]).toEqual(['vault-2'])
    expect(result.has('vault-1')).toBe(true)
    expect(result.has('vault-2')).toBe(true)
    expect(loader.queries).toBe(2)
  })

  it('returns an empty map without querying for an empty ID list', async () => {
    const query = jest.fn<DbLike['query']>()
    const loader = new AnalyticsBatchLoader(makeDb(query))

    await expect(loader.loadVaults([])).resolves.toEqual(new Map())

    expect(query).not.toHaveBeenCalled()
    expect(loader.queries).toBe(0)
  })

  it('propagates query failures and allows a later retry', async () => {
    const databaseError = new Error('vault query failed')
    const query = jest.fn<DbLike['query']>()
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ rows: [vaultRow()] })
    const loader = new AnalyticsBatchLoader(makeDb(query))

    await expect(loader.loadVaults(['vault-1'])).rejects.toBe(databaseError)
    expect(loader.queries).toBe(0)

    await expect(loader.loadVaults(['vault-1'])).resolves.toEqual(
      new Map([['vault-1', vaultRow()]]),
    )
    expect(loader.queries).toBe(1)
  })

  it('omits vault IDs not returned by the database', async () => {
    const query = jest.fn<DbLike['query']>().mockResolvedValue({ rows: [] })
    const loader = new AnalyticsBatchLoader(makeDb(query))

    await expect(loader.loadVaults(['missing-vault'])).resolves.toEqual(new Map())
  })
})

describe('AnalyticsBatchLoader.loadMilestones', () => {
  it('batches unique IDs and fills zero aggregates for vaults without milestones', async () => {
    const query = jest.fn<DbLike['query']>().mockResolvedValue({
      rows: [{
        ...milestoneRow(),
        milestoneCount: '3',
        completedMilestones: '1',
        pendingMilestones: '2',
      }],
    })
    const loader = new AnalyticsBatchLoader(makeDb(query))

    const result = await loader.loadMilestones(['vault-1', 'vault-2', 'vault-1'])

    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE vault_id IN ($1,$2)'),
      ['vault-1', 'vault-2'],
    )
    expect(result).toEqual(new Map([
      ['vault-1', milestoneRow()],
      ['vault-2', {
        vaultId: 'vault-2',
        milestoneCount: 0,
        completedMilestones: 0,
        pendingMilestones: 0,
      }],
    ]))
    expect(loader.queries).toBe(1)
  })

  it('caches loaded milestone aggregates and queries only uncached IDs', async () => {
    const query = jest.fn<DbLike['query']>()
      .mockResolvedValueOnce({ rows: [milestoneRow()] })
      .mockResolvedValueOnce({
        rows: [milestoneRow({ vaultId: 'vault-2', milestoneCount: 1 })],
      })
    const loader = new AnalyticsBatchLoader(makeDb(query))

    await loader.loadMilestones(['vault-1'])
    const result = await loader.loadMilestones(['vault-1', 'vault-2'])

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1][1]).toEqual(['vault-2'])
    expect(result.has('vault-1')).toBe(true)
    expect(result.has('vault-2')).toBe(true)
    expect(loader.queries).toBe(2)
  })

  it('returns an empty map without querying for an empty ID list', async () => {
    const query = jest.fn<DbLike['query']>()
    const loader = new AnalyticsBatchLoader(makeDb(query))

    await expect(loader.loadMilestones([])).resolves.toEqual(new Map())

    expect(query).not.toHaveBeenCalled()
    expect(loader.queries).toBe(0)
  })

  it('propagates query failures and allows a later retry', async () => {
    const databaseError = new Error('milestone query failed')
    const query = jest.fn<DbLike['query']>()
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ rows: [milestoneRow()] })
    const loader = new AnalyticsBatchLoader(makeDb(query))

    await expect(loader.loadMilestones(['vault-1'])).rejects.toBe(databaseError)
    expect(loader.queries).toBe(0)

    await expect(loader.loadMilestones(['vault-1'])).resolves.toEqual(
      new Map([['vault-1', milestoneRow()]]),
    )
    expect(loader.queries).toBe(1)
  })
})

describe('getOrgAnalyticsBatched', () => {
  it('aggregates vault and milestone results from batched queries', async () => {
    const query = jest.fn<DbLike['query']>()
      .mockResolvedValueOnce({
        rows: [
          vaultRow({ vaultId: 'vault-1', amount: '10', status: 'active' }),
          vaultRow({ vaultId: 'vault-2', amount: '20', status: 'completed' }),
          vaultRow({ vaultId: 'vault-3', amount: '30', status: 'failed' }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          milestoneRow({ vaultId: 'vault-2', milestoneCount: 2, completedMilestones: 1 }),
          milestoneRow({ vaultId: 'vault-3', milestoneCount: 1, completedMilestones: 1 }),
        ],
      })

    await expect(
      getOrgAnalyticsBatched(['vault-1', 'vault-2', 'vault-3', 'vault-1'], makeDb(query)),
    ).resolves.toEqual({
      totalVaults: 3,
      activeVaults: 1,
      completedVaults: 1,
      failedVaults: 1,
      totalLockedCapital: '60',
      successRate: 0.5,
      totalMilestones: 3,
      completedMilestones: 2,
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0][1]).toEqual(['vault-1', 'vault-2', 'vault-3'])
    expect(query.mock.calls[1][1]).toEqual(['vault-1', 'vault-2', 'vault-3'])
  })

  it('returns zeroed analytics without querying when there are no vault IDs', async () => {
    const query = jest.fn<DbLike['query']>()

    await expect(getOrgAnalyticsBatched([], makeDb(query))).resolves.toEqual({
      totalVaults: 0,
      activeVaults: 0,
      completedVaults: 0,
      failedVaults: 0,
      totalLockedCapital: '0',
      successRate: 0,
      totalMilestones: 0,
      completedMilestones: 0,
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('propagates a vault query failure', async () => {
    const databaseError = new Error('vault query failed')
    const query = jest.fn<DbLike['query']>().mockRejectedValue(databaseError)

    await expect(
      getOrgAnalyticsBatched(['vault-1'], makeDb(query)),
    ).rejects.toBe(databaseError)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('propagates a milestone query failure after loading vaults', async () => {
    const databaseError = new Error('milestone query failed')
    const query = jest.fn<DbLike['query']>()
      .mockResolvedValueOnce({ rows: [vaultRow()] })
      .mockRejectedValueOnce(databaseError)

    await expect(
      getOrgAnalyticsBatched(['vault-1'], makeDb(query)),
    ).rejects.toBe(databaseError)
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe('createAnalyticsBatchLoader', () => {
  beforeEach(() => {
    defaultQuery.mockReset()
  })

  it('uses the injected database client', async () => {
    const injectedQuery = jest.fn<DbLike['query']>().mockResolvedValue({
      rows: [vaultRow()],
    })
    const loader = createAnalyticsBatchLoader(makeDb(injectedQuery))

    await expect(loader.loadVaults(['vault-1'])).resolves.toEqual(
      new Map([['vault-1', vaultRow()]]),
    )
    expect(injectedQuery).toHaveBeenCalledTimes(1)
    expect(defaultQuery).not.toHaveBeenCalled()
  })

  it('uses the default database client when none is injected', async () => {
    defaultQuery.mockResolvedValue({ rows: [vaultRow()] })
    const loader = createAnalyticsBatchLoader()

    await expect(loader.loadVaults(['vault-1'])).resolves.toEqual(
      new Map([['vault-1', vaultRow()]]),
    )
    expect(defaultQuery).toHaveBeenCalledTimes(1)
  })
})
